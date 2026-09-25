import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { blockUser } from "../../db/sqlite/blocks";
import { initSqlite, getSqliteDb } from "../../db/sqlite/connection";
import { directConversationId, getConversation, openDirectConversation } from "../../db/sqlite/conversations";
import { createServerConfigIfNotExists, setServerOwner, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import { resetRings } from "../utils/callRings";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { refreshClientPermissions } from "../utils/standing";
import { registerCallHandlers } from "./calls";
import { registerChatHandlers } from "./chat";
import { registerContactPrefsHandlers } from "./contactPrefs";
import { registerDirectMessageHandlers } from "./dm";
import type { EventHandlerMap, HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * GRYT-1470: every gate the recipient's own settings close, asked of the handlers
 * a real socket reaches. Nobody here outranks the settings, the owner included.
 */

const HOST = "contact.test:5001";

let dir: string;

interface Emitted {
  event: string;
  payload: unknown;
  meta?: unknown;
}

interface Member {
  clientId: string;
  serverUserId: string;
  grytUserId: string;
  nickname: string;
  accessToken: string;
  handlers: EventHandlerMap;
  received: (event: string) => { payload: unknown; meta?: unknown }[];
  clear: () => void;
}

const clientsInfo: Clients = {};
const sockets = new Map<string, { emit: (event: string, payload?: unknown, meta?: unknown) => boolean }>();
const io = {
  to() {
    return { emit() {} };
  },
  emit() {},
  sockets: { sockets },
} as unknown as HandlerContext["io"];

let seq = 0;

async function connect(nickname: string): Promise<Member> {
  seq += 1;
  const clientId = `contact-${seq}`;
  const grytUserId = `account-contact-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");

  const emitted: Emitted[] = [];
  const record = (event: string, payload?: unknown, meta?: unknown) => {
    emitted.push({ event, payload, meta });
    return true;
  };
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: record,
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
  };
  sockets.set(clientId, { emit: record });

  clientsInfo[clientId] = {
    serverUserId: user.server_user_id,
    grytUserId,
    nickname,
    color: "#666666",
    isMuted: false,
    isDeafened: false,
    streamID: "",
    hasJoinedChannel: false,
    voiceChannelId: "",
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
  } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);

  const ctx = {
    io,
    socket,
    clientId,
    serverId: "contact-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.3.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    clientId,
    serverUserId: user.server_user_id,
    grytUserId,
    nickname,
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname,
      serverHost: HOST,
      tokenVersion: 0,
    }),
    handlers: {
      ...registerChatHandlers(ctx),
      ...registerDirectMessageHandlers(ctx),
      ...registerCallHandlers(ctx),
      ...registerVoiceHandlers(ctx),
      ...registerContactPrefsHandlers(ctx),
    },
    received: (event: string) => emitted.filter((e) => e.event === event).map(({ payload, meta }) => ({ payload, meta })),
    clear: () => {
      emitted.length = 0;
    },
  };
}

type Rule = "everyone" | "friends" | "nobody";

async function choose(who: Member, messages: Rule, calls: Rule): Promise<void> {
  await who.handlers["contact:prefs:set"]({ accessToken: who.accessToken, messages, calls });
}

let nonceSeq = 0;

/** Sends and reports what came back: the echo, or the refusal's error code. */
async function send(from: Member, conversationId: string): Promise<string> {
  from.clear();
  nonceSeq += 1;
  const nonce = `n-${nonceSeq}`;
  await from.handlers["chat:send"]({ accessToken: from.accessToken, conversationId, text: `hello ${nonceSeq}`, nonce });
  if (from.received("chat:new").length > 0) return "sent";
  const refusal = from.received("chat:error")[0];
  assert.ok(refusal, "chat:send answered with neither a message nor a refusal");
  // Carries the nonce, which is what lets the sender's pending row settle.
  assert.deepEqual(refusal.meta, { nonce });
  return (refusal.payload as { error?: string }).error ?? String(refusal.payload);
}

async function ring(from: Member, conversationId: string): Promise<void> {
  await from.handlers["call:ring"]({ accessToken: from.accessToken, conversationId });
}

function lastError(who: Member, event: string): { error?: string; message?: string } | undefined {
  const all = who.received(event);
  return all[all.length - 1]?.payload as { error?: string; message?: string } | undefined;
}

let alice: Member;
let bob: Member;
let carol: Member;
let owner: Member;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-contact-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  resetChannelIdCache();

  alice = await connect("Alice");
  bob = await connect("Bob");
  carol = await connect("Carol");
  owner = await connect("Olive");
  await setServerOwner(owner.grytUserId);
  await setServerRole(owner.serverUserId, "owner");
  await refreshClientPermissions(clientsInfo, owner.clientId);
});

beforeEach(async () => {
  resetRings();
  resetRateLimits();
  for (const m of [alice, bob, carol, owner]) {
    await choose(m, "everyone", "friends");
    m.clear();
    clientsInfo[m.clientId].hasJoinedChannel = false;
    clientsInfo[m.clientId].voiceChannelId = "";
  }
});

after(() => {
  resetRings();
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("contact:prefs", () => {
  it("reads the defaults when nothing is stored: messages from anyone, calls from friends", async () => {
    await alice.handlers["contact:prefs:get"]({ accessToken: alice.accessToken });
    assert.deepEqual(alice.received("contact:prefs")[0]?.payload, { messages: "everyone", calls: "friends" });
  });

  it("keeps a choice, and deletes the row once it is back at the defaults", async () => {
    const rows = () =>
      (getSqliteDb().prepare(`SELECT COUNT(*) AS n FROM contact_prefs WHERE gryt_user_id = ?`).get(alice.grytUserId) as { n: number }).n;

    await choose(alice, "nobody", "nobody");
    assert.equal(rows(), 1);
    alice.clear();
    await alice.handlers["contact:prefs:get"]({ accessToken: alice.accessToken });
    assert.deepEqual(alice.received("contact:prefs")[0]?.payload, { messages: "nobody", calls: "nobody" });

    await choose(alice, "everyone", "friends");
    assert.equal(rows(), 0);
  });

  it("refuses a word it doesn't know rather than storing it", async () => {
    await alice.handlers["contact:prefs:set"]({ accessToken: alice.accessToken, messages: "moderators", calls: "everyone" });
    assert.equal(lastError(alice, "server:error")?.error, "invalid_payload");
  });
});

describe("dm:open", () => {
  it("won't start a conversation with somebody who takes messages from nobody", async () => {
    await choose(carol, "nobody", "nobody");
    await alice.handlers["dm:open"]({ accessToken: alice.accessToken, targetServerUserId: carol.serverUserId });

    assert.equal(lastError(alice, "dm:error")?.error, "contact_refused");
    assert.equal(await getConversation(directConversationId(alice.serverUserId, carol.serverUserId)), null);
  });

  it("starts one when they take messages from anyone", async () => {
    await alice.handlers["dm:open"]({ accessToken: alice.accessToken, targetServerUserId: carol.serverUserId });
    assert.equal(alice.received("dm:error").length, 0);
    assert.equal(alice.received("dm:opened").length, 1);
  });
});

describe("chat:send in a one-to-one", () => {
  let pair: string;

  before(async () => {
    pair = (await openDirectConversation(alice.serverUserId, bob.serverUserId)).conversation_id;
  });

  it("a stricter setting closes a conversation that's already open", async () => {
    assert.equal(await send(alice, pair), "sent");
    assert.equal(await send(bob, pair), "sent");

    await choose(bob, "nobody", "nobody");
    assert.equal(await send(alice, pair), "contact_refused");

    await choose(bob, "everyone", "friends");
    assert.equal(await send(alice, pair), "sent");
  });

  it("friends lets through somebody they've written to, and nobody else", async () => {
    // Bob wrote to Alice above. Carol's conversation with him was opened before he
    // changed the setting, and he never answered it.
    const withCarol = (await openDirectConversation(carol.serverUserId, bob.serverUserId)).conversation_id;
    assert.equal(await send(carol, withCarol), "sent");

    await choose(bob, "friends", "friends");
    assert.equal(await send(alice, pair), "sent");
    assert.equal(await send(carol, withCarol), "contact_refused");
  });

  it("the owner can't get past it", async () => {
    const withOwner = (await openDirectConversation(owner.serverUserId, bob.serverUserId)).conversation_id;
    await choose(bob, "nobody", "nobody");
    assert.equal(await send(owner, withOwner), "contact_refused");
  });
});

describe("groups", () => {
  it("won't put somebody in a new group when they take messages from nobody", async () => {
    await choose(carol, "nobody", "nobody");
    await alice.handlers["dm:group:create"]({ accessToken: alice.accessToken, memberIds: [bob.serverUserId, carol.serverUserId] });

    const refusal = lastError(alice, "dm:error");
    assert.equal(refusal?.error, "contact_refused");
    assert.match(refusal?.message ?? "", /Carol/);
    assert.equal(alice.received("dm:opened").length, 0);
  });

  it("won't add them to an existing group either", async () => {
    await alice.handlers["dm:group:create"]({ accessToken: alice.accessToken, memberIds: [bob.serverUserId, owner.serverUserId] });
    const group = alice.received("dm:opened")[0]?.payload as { conversation_id: string };
    assert.ok(group?.conversation_id);

    await choose(carol, "nobody", "nobody");
    alice.clear();
    await alice.handlers["dm:group:add"]({ accessToken: alice.accessToken, conversationId: group.conversation_id, targetServerUserId: carol.serverUserId });
    assert.equal(lastError(alice, "dm:error")?.error, "contact_refused");

    await choose(carol, "everyone", "friends");
    alice.clear();
    await alice.handlers["dm:group:add"]({ accessToken: alice.accessToken, conversationId: group.conversation_id, targetServerUserId: carol.serverUserId });
    assert.equal(alice.received("dm:error").length, 0);
  });
});

describe("call:ring", () => {
  let pair: string;
  let quiet: Member;
  let quietPair: string;

  before(async () => {
    pair = directConversationId(alice.serverUserId, bob.serverUserId);
    quiet = await connect("Quinn");
    quietPair = (await openDirectConversation(alice.serverUserId, quiet.serverUserId)).conversation_id;
  });

  it("by default, won't ring somebody who has never written to the caller", async () => {
    await send(alice, quietPair);
    quiet.clear();
    alice.clear();

    await ring(alice, quietPair);
    assert.equal(lastError(alice, "call:error")?.error, "contact_refused");
    assert.equal(quiet.received("call:incoming").length, 0);

    assert.equal(await send(quiet, quietPair), "sent");
    alice.clear();
    await ring(alice, quietPair);
    assert.equal(alice.received("call:error").length, 0);
    assert.equal(quiet.received("call:incoming").length, 1);
  });

  it("is never looser than the message setting", async () => {
    await choose(bob, "nobody", "everyone");
    await ring(alice, pair);
    assert.equal(lastError(alice, "call:error")?.error, "contact_refused");
    assert.equal(bob.received("call:incoming").length, 0);
  });

  it("the owner can't ring past it", async () => {
    const withOwner = directConversationId(owner.serverUserId, bob.serverUserId);
    await choose(bob, "everyone", "nobody");
    await ring(owner, withOwner);
    assert.equal(lastError(owner, "call:error")?.error, "contact_refused");
    assert.equal(bob.received("call:incoming").length, 0);
  });

  it("still rings out silently when a block is also in the way, so the refusal can't give the block away", async () => {
    const blocker = await connect("Bea");
    const withBlocker = (await openDirectConversation(alice.serverUserId, blocker.serverUserId)).conversation_id;
    await blockUser(blocker.grytUserId, alice.grytUserId);
    await choose(blocker, "everyone", "nobody");
    alice.clear();

    await ring(alice, withBlocker);
    assert.equal(alice.received("call:error").length, 0);
    assert.equal(blocker.received("call:incoming").length, 0);
    resetRings();
  });

  it("in a group, rings whoever takes calls from the caller and skips the rest", async () => {
    await alice.handlers["dm:group:create"]({ accessToken: alice.accessToken, memberIds: [bob.serverUserId, carol.serverUserId] });
    const group = (alice.received("dm:opened")[0]?.payload as { conversation_id: string }).conversation_id;

    await choose(bob, "everyone", "everyone");
    await choose(carol, "everyone", "nobody");
    bob.clear();
    carol.clear();
    alice.clear();

    await ring(alice, group);
    assert.equal(alice.received("call:error").length, 0);
    assert.equal(bob.received("call:incoming").length, 1);
    assert.equal(carol.received("call:incoming").length, 0);
  });
});

describe("joining a one-to-one call", () => {
  let pair: string;
  let stranger: Member;
  let strangerPair: string;

  before(async () => {
    pair = directConversationId(alice.serverUserId, bob.serverUserId);
    stranger = await connect("Stan");
    strangerPair = (await openDirectConversation(stranger.serverUserId, bob.serverUserId)).conversation_id;
  });

  const joinError = (who: Member) => lastError(who, "voice:room:error");

  it("refuses somebody the other person doesn't take calls from", async () => {
    await stranger.handlers["voice:room:request"](strangerPair);
    assert.equal(joinError(stranger)?.error, "contact_refused");
  });

  it("lets them in to answer a ring from the other person", async () => {
    await choose(stranger, "everyone", "everyone");
    await ring(bob, strangerPair);
    assert.equal(bob.received("call:error").length, 0);

    stranger.clear();
    await stranger.handlers["voice:room:request"](strangerPair);
    // Past the gate: the next thing it reaches is the missing SFU.
    assert.ok(joinError(stranger));
    assert.notEqual(joinError(stranger)?.error, "contact_refused");
  });

  it("lets them in while the other person is already in the room", async () => {
    clientsInfo[bob.clientId].hasJoinedChannel = true;
    clientsInfo[bob.clientId].voiceChannelId = strangerPair;
    await stranger.handlers["voice:room:request"](strangerPair);
    assert.ok(joinError(stranger));
    assert.notEqual(joinError(stranger)?.error, "contact_refused");
  });

  it("the owner can't join past it", async () => {
    const withOwner = directConversationId(owner.serverUserId, bob.serverUserId);
    await choose(bob, "everyone", "nobody");
    await owner.handlers["voice:room:request"](withOwner);
    assert.equal(joinError(owner)?.error, "contact_refused");
  });

  it("lets in somebody the other person has written to", async () => {
    // Bob wrote to Alice in the chat:send cases.
    await alice.handlers["voice:room:request"](pair);
    assert.ok(joinError(alice));
    assert.notEqual(joinError(alice)?.error, "contact_refused");
  });
});
