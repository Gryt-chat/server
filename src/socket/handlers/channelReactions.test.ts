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
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Reacting in an ordinary text channel, end to end.
 *
 * `directMessages.test.ts` already covers a reaction in a DM, where the
 * broadcast goes to a known member list. A channel takes the other branch of
 * `recipientClientIds` — everybody connected — and had no coverage at all, so
 * "reactions do not appear" had nothing to rule the server out with.
 */

const HOST = "reactions.test:5001";
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

function makeParty(seq: number, grytUserId: string, nickname: string, serverUserId: string): Party {
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

  const ctx = {
    io: { sockets: { sockets } },
    socket,
    clientId,
    serverId: "reactions-test",
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
  dir = mkdtempSync(join(tmpdir(), "gryt-reactions-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: CHANNEL_ID, name: "general", type: "text" });

  const a = await upsertUser("account-alice", "Alice");
  const b = await upsertUser("account-bob", "Bob");
  // Owner both, so nothing here can fail on a missing permission — the point is
  // the delivery path, not the gate.
  await setServerRole(a.server_user_id, "owner");
  await setServerRole(b.server_user_id, "owner");

  alice = makeParty(1, "account-alice", "Alice", a.server_user_id);
  bob = makeParty(2, "account-bob", "Bob", b.server_user_id);
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

describe("reacting in a text channel", () => {
  let messageId: string;

  it("delivers chat:reaction to everybody in the channel", async () => {
    await alice.handlers["chat:send"]({
      conversationId: CHANNEL_ID,
      text: "something worth reacting to",
      accessToken: alice.accessToken,
    });

    const sent = alice.received("chat:new").at(-1) as { message_id?: string } | undefined;
    assert.ok(sent?.message_id, "the message was not accepted");
    messageId = sent.message_id;

    await bob.handlers["chat:react"]({
      conversationId: CHANNEL_ID,
      messageId,
      reactionSrc: "👍",
      accessToken: bob.accessToken,
    });

    assert.deepEqual(bob.received("chat:error"), [], "the server refused the reaction");
    assert.equal(bob.received("chat:reaction").length, 1, "the reactor heard nothing back");
    assert.equal(alice.received("chat:reaction").length, 1, "the author was not told");
  });

  /*
   * The shape matters as much as the delivery. The client replaces
   * `msg.reactions` with whatever arrives, and renders nothing at all when that
   * is null or empty — so a broadcast carrying the right message id and an
   * empty reactions array looks exactly like a reaction that never happened.
   */
  it("carries the reaction on the broadcast", () => {
    const payload = alice.received("chat:reaction")[0] as {
      message_id?: string;
      conversation_id?: string;
      reactions?: { src: string; amount: number; users: string[] }[] | null;
    };

    assert.equal(payload.message_id, messageId, "a different message id than the one reacted to");
    assert.equal(payload.conversation_id, CHANNEL_ID, "a different conversation than the one open");

    assert.ok(Array.isArray(payload.reactions), "reactions came back as something other than an array");
    assert.equal(payload.reactions!.length, 1);
    assert.equal(payload.reactions![0].src, "👍");
    assert.equal(payload.reactions![0].amount, 1);
    assert.deepEqual(payload.reactions![0].users, [bob.serverUserId]);
  });

  it("keeps the reaction on the message when it is fetched again", async () => {
    await alice.handlers["chat:fetch"]({
      conversationId: CHANNEL_ID,
      accessToken: alice.accessToken,
    });

    const history = alice.received("chat:history").at(-1) as {
      items?: { message_id: string; reactions?: unknown }[];
    };
    const stored = history?.items?.find((m) => m.message_id === messageId);

    assert.ok(stored, "the message is missing from history");
    assert.ok(Array.isArray(stored.reactions), "history dropped the reactions");
    assert.equal((stored.reactions as unknown[]).length, 1);
  });

  it("takes the reaction back when the same person reacts again", async () => {
    await bob.handlers["chat:react"]({
      conversationId: CHANNEL_ID,
      messageId,
      reactionSrc: "👍",
      accessToken: bob.accessToken,
    });

    const latest = alice.received("chat:reaction").at(-1) as { reactions?: unknown[] | null };
    const left = latest.reactions ?? [];
    assert.equal(left.length, 0, "reacting twice should remove it");
  });
});
