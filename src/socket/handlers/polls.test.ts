import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { upsertServerChannel } from "../../db/sqlite/channels";
import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { refreshClientPermissions } from "../utils/standing";
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/** Polls over the socket (GRYT-1732): sent, voted on, and kept per viewer. */

const HOST = "polls.test:5001";
const CHANNEL_ID = "chan-general";

interface Party {
  clientId: string;
  serverUserId: string;
  accessToken: string;
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
}

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let alice: Party;
let bob: Party;
let carol: Party;

async function makeParty(seq: number, grytUserId: string, nickname: string, serverUserId: string): Promise<Party> {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];

  const record = {
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
  };
  sockets.set(clientId, record);

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: record.emit,
    join() {},
    leave() {},
    to: () => ({ emit() {} }),
  };

  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];
  // The cache every admitted socket carries: verifyClient sets it on join, and
  // the recipient gate reads it.
  await refreshClientPermissions(clientsInfo, clientId);

  const ctx = {
    io: { sockets: { sockets } },
    socket,
    clientId,
    serverId: "polls-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.0.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    clientId,
    serverUserId,
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId,
      nickname,
      serverHost: HOST,
      tokenVersion: 0,
    }),
    handlers: registerChatHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-polls-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: CHANNEL_ID, name: "general", type: "text" });

  const a = await upsertUser("account-alice", "Alice");
  const b = await upsertUser("account-bob", "Bob");
  const c = await upsertUser("account-carol", "Carol");
  await setServerRole(a.server_user_id, "owner");
  await setServerRole(b.server_user_id, "admin");
  await setServerRole(c.server_user_id, "member");

  alice = await makeParty(1, "account-alice", "Alice", a.server_user_id);
  bob = await makeParty(2, "account-bob", "Bob", b.server_user_id);
  carol = await makeParty(3, "account-carol", "Carol", c.server_user_id);
});

after(() => {
  delete process.env.DATA_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows holds the SQLite file open past the test run. Leaving a temp
    // directory behind is not worth failing a suite over.
  }
});

type Poll = { question: string; options: { text: string; count: number; voters?: string[] }[]; mine?: number[]; voter_count: number; allowed_roles: string[] | null };

async function sendPoll(poll: Record<string, unknown>): Promise<string> {
  await alice.handlers["chat:send"]({ conversationId: CHANNEL_ID, poll, accessToken: alice.accessToken });
  const sent = alice.received("chat:new").at(-1) as { message_id?: string; poll?: Poll; text?: string } | undefined;
  assert.ok(sent?.message_id, `the poll was refused: ${JSON.stringify(alice.received("chat:error").at(-1))}`);
  return sent.message_id;
}

function vote(who: Party, messageId: string, choices: number[]) {
  return who.handlers["poll:vote"]({ conversationId: CHANNEL_ID, messageId, choices, accessToken: who.accessToken });
}

function lastUpdate(who: Party): Poll {
  return (who.received("poll:updated").at(-1) as { poll: Poll }).poll;
}

describe("polls", () => {
  let messageId: string;

  it("sends a poll with a line older apps show, asking to update", async () => {
    messageId = await sendPoll({ question: "Lunch?", options: ["Pizza", "Sushi"] });
    const sent = alice.received("chat:new").at(-1) as { poll: Poll; text: string; text_fallback?: boolean };
    assert.equal(sent.poll.question, "Lunch?");
    // Not marked a fallback: apps that hide fallback text and don't know polls would show nothing.
    assert.equal(sent.text_fallback, undefined);
    assert.equal((sent as { kind?: string }).kind, "poll");
    assert.match(sent.text, /Poll: Lunch\?/);
    assert.match(sent.text, /Update Gryt/);
    assert.equal((sent.poll as unknown as { votes?: unknown }).votes, undefined, "raw votes leaked");
  });

  it("tells everybody the new totals and each viewer their own pick", async () => {
    await vote(bob, messageId, [1]);
    assert.deepEqual(bob.received("chat:error"), []);
    assert.deepEqual(lastUpdate(bob).mine, [1]);
    assert.deepEqual(lastUpdate(alice).mine, []);
    assert.equal(lastUpdate(alice).options[1].count, 1);
    assert.deepEqual(lastUpdate(alice).options[1].voters, [bob.serverUserId]);
  });

  it("keeps the vote and the viewer's pick in history", async () => {
    await bob.handlers["chat:fetch"]({ conversationId: CHANNEL_ID, accessToken: bob.accessToken });
    const history = bob.received("chat:history").at(-1) as { items: { message_id: string; poll?: Poll }[] };
    const stored = history.items.find((m) => m.message_id === messageId);
    assert.deepEqual(stored?.poll?.mine, [1]);
    assert.equal(stored?.poll?.voter_count, 1);
  });

  it("refuses a second pick on a single-answer poll", async () => {
    await vote(bob, messageId, [0, 1]);
    assert.equal((bob.received("chat:error").at(-1) as { error: string }).error, "poll_choice");
  });

  it("refuses an edit", async () => {
    await alice.handlers["chat:edit"]({ conversationId: CHANNEL_ID, messageId, text: "changed", accessToken: alice.accessToken });
    assert.equal((alice.received("chat:error").at(-1) as { error: string }).error, "poll_not_editable");
  });

  it("hides who voted on an anonymous poll", async () => {
    const id = await sendPoll({ question: "Secret?", options: ["Yes", "No"], anonymous: true });
    await vote(bob, id, [0]);
    assert.equal(lastUpdate(alice).options[0].count, 1);
    assert.equal(lastUpdate(alice).options[0].voters, undefined);
    assert.deepEqual(lastUpdate(bob).mine, [0]);
  });

  it("lets only the picked roles answer", async () => {
    const id = await sendPoll({ question: "Admins only?", options: ["A", "B"], allowed_roles: ["admin", "no-such-role"] });
    const sent = alice.received("chat:new").at(-1) as { poll: Poll };
    assert.deepEqual(sent.poll.allowed_roles, ["admin"], "a role that doesn't exist was kept");
    await vote(carol, id, [0]);
    assert.equal((carol.received("chat:error").at(-1) as { error: string }).error, "poll_not_allowed");
    await vote(bob, id, [0]);
    assert.equal(lastUpdate(bob).options[0].count, 1);
  });

  it("refuses text alongside a poll", async () => {
    const before = alice.received("chat:new").length;
    await alice.handlers["chat:send"]({ conversationId: CHANNEL_ID, text: "hi", poll: { question: "Q", options: ["a", "b"] }, accessToken: alice.accessToken });
    assert.equal(alice.received("chat:new").length, before);
    assert.equal((alice.received("chat:error").at(-1) as { error: string }).error, "poll_not_allowed_here");
  });

  it("doesn't lose a vote when two land at once", async () => {
    const id = await sendPoll({ question: "Race?", options: ["A", "B"] });
    await Promise.all([vote(bob, id, [0]), vote(carol, id, [1])]);
    const final = lastUpdate(alice);
    assert.equal(final.voter_count, 2);
  });
});
