import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { setContactPrefs } from "../../db/sqlite/contactPrefs";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { refreshClientPermissions } from "../utils/standing";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { registerChatHandlers } from "./chat";
import { registerDirectMessageHandlers } from "./dm";
import { registerBlockHandlers } from "./blocks";
import { registerCallHandlers } from "./calls";
import { registerTypingHandlers } from "./typing";
import { registerVoiceHandlers } from "./voice";
import { createGroupConversation, openDirectConversation } from "../../db/sqlite/conversations";
import { resetRings } from "../utils/callRings";
import { resetRateLimits } from "../../utils/rateLimiter";
import { upsertServerChannel } from "../../db/sqlite/channels";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * The queries can be right while nothing asks them, and a block that changes
 * nothing is worse than none. Nobody here holds a role, deliberately.
 */

const HOST = "blocks.test:5001";
const CHANNEL = "general";

let dir: string;

interface Emitted {
  event: string;
  payload: unknown;
}

interface Participant {
  clientId: string;
  serverUserId: string;
  grytUserId: string;
  accessToken: string;
  emitted: Emitted[];
  ctx: HandlerContext;
  handlers: EventHandlerMap;
  /** Everything this socket received under `event`, oldest first. */
  received: (event: string) => unknown[];
  /** Forget what has been seen, so the next act starts from nothing. */
  clear: () => void;
}

/** One `io` shared by everybody, so a targeted emit can be observed. */
function makeWorld() {
  const clientsInfo: Clients = {};
  const sockets = new Map<string, {
    emit: (event: string, payload?: unknown) => boolean;
    leave: () => void;
    to: () => { emit: () => void };
  }>();

  const io = {
    to() {
      return { emit() {} };
    },
    emit() {},
    sockets: { sockets },
  };

  return { clientsInfo, sockets, io };
}

const world = makeWorld();

let seq = 0;

/** The voice fields are what a socket looks like once a join has finished; the
    chat handlers read `serverUserId` and nothing else. */
async function connectMember(
  nickname: string,
  grytUserIdOverride?: string,
  roleId = "member",
): Promise<Participant> {
  seq += 1;
  const clientId = `socket-${seq}`;
  const grytUserId = grytUserIdOverride ?? `account-block-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, roleId);
  // About blocks, not settings: calls default to friends only since GRYT-1470.
  await setContactPrefs(grytUserId, { messages: "everyone", calls: "everyone" });

  const emitted: Emitted[] = [];
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    join() {},
    leave() {},
    rooms: new Set<string>(),
    to() {
      return { emit() {} };
    },
  };

  world.sockets.set(clientId, {
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    // What removeFromVoice reaches for when the server takes somebody out of a call.
    leave() {},
    to() {
      return { emit() {} };
    },
  });

  world.clientsInfo[clientId] = {
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
  // The cache every admitted socket carries: verifyClient sets it on join, and
  // the recipient gate reads it.
  await refreshClientPermissions(world.clientsInfo, clientId);

  const ctx = {
    io: world.io,
    socket,
    clientId,
    serverId: "block-test",
    clientsInfo: world.clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.0.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    clientId,
    serverUserId: user.server_user_id,
    grytUserId,
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname,
      serverHost: HOST,
      tokenVersion: 0,
    }),
    emitted,
    ctx,
    handlers: {
      ...registerChatHandlers(ctx),
      ...registerDirectMessageHandlers(ctx),
      ...registerBlockHandlers(ctx),
      ...registerCallHandlers(ctx),
      ...registerTypingHandlers(ctx),
      ...registerVoiceHandlers(ctx),
    },
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    clear: () => {
      emitted.length = 0;
    },
  };
}


let alice: Participant;
let bob: Participant;
let mallory: Participant;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-blocks-"));
  process.env.DATA_DIR = dir;
  // requireAuth refuses everything without a config row, which would make every
  // case below pass for the wrong reason.
  await initSqlite();
  await createServerConfigIfNotExists();
  // A real channel, because delivery only reaches people the access check has
  // let through and it has nothing to let them through to otherwise.
  await upsertServerChannel({ channelId: CHANNEL, name: "General", type: "text", position: 10 });
  resetChannelIdCache();

  alice = await connectMember("Alice");
  bob = await connectMember("Bob");
  mallory = await connectMember("Mallory");
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function clearAll(): void {
  alice.clear();
  bob.clear();
  mallory.clear();
}

async function block(who: Participant, whom: Participant): Promise<void> {
  clearAll();
  await who.handlers["user:block"]({
    accessToken: who.accessToken,
    serverUserId: whom.serverUserId,
  });
}

async function unblock(who: Participant, whom: Participant): Promise<void> {
  clearAll();
  await who.handlers["user:unblock"]({
    accessToken: who.accessToken,
    serverUserId: whom.serverUserId,
  });
}

/** Everybody who received a `chat:new` since the last clear. */
function whoGot(conversationId: string): string[] {
  return [alice, bob, mallory]
    .filter((p) =>
      p
        .received("chat:new")
        .some((m) => (m as { conversation_id?: string }).conversation_id === conversationId),
    )
    .map((p) => p.serverUserId);
}

describe("blocking somebody", () => {
  it("is recorded, and shows in the blocker's own list", async () => {
    await block(alice, mallory);
    clearAll();

    await alice.handlers["user:blocks:list"]({ accessToken: alice.accessToken });
    const list = alice.received("user:blocks")[0] as {
      blocked: { serverUserId: string; nickname: string }[];
    };

    assert.equal(list.blocked.length, 1);
    assert.equal(list.blocked[0].serverUserId, mallory.serverUserId);
    assert.equal(list.blocked[0].nickname, "Mallory");

    await unblock(alice, mallory);
  });

  it("is nobody else's business", async () => {
    await block(alice, mallory);
    clearAll();

    /* The act itself must not reach the blocked person. A member-list marker,
     * an event, anything — it invites the retaliation the block is for. */
    assert.deepEqual(mallory.emitted, [], "Mallory heard nothing at all");

    await mallory.handlers["user:blocks:list"]({ accessToken: mallory.accessToken });
    const hers = mallory.received("user:blocks")[0] as { blocked: unknown[] };
    assert.equal(hers.blocked.length, 0, "and her own list does not mention it");

    await unblock(alice, mallory);
  });

  it("refuses to block yourself", async () => {
    clearAll();
    await alice.handlers["user:block"]({
      accessToken: alice.accessToken,
      serverUserId: alice.serverUserId,
    });

    const errors = alice.received("server:error") as { error: string }[];
    assert.equal(errors[0]?.error, "cannot_block_self");
  });
});

describe("what a block stops", () => {
  it("keeps their channel messages away from the blocker, and only the blocker", async () => {
    await block(alice, mallory);
    clearAll();

    await mallory.handlers["chat:send"]({
      conversationId: "general",
      accessToken: mallory.accessToken,
      text: "still talking",
    });

    const got = whoGot("general");
    assert.ok(!got.includes(alice.serverUserId), "Alice does not receive it");
    assert.ok(got.includes(bob.serverUserId), "Bob, who blocked nobody, still does");
    assert.ok(
      got.includes(mallory.serverUserId),
      "and Mallory sees her own message, or sending would look like it failed",
    );

    await unblock(alice, mallory);
  });

  it("does not stop the blocker being heard", async () => {
    await block(alice, mallory);
    clearAll();

    await alice.handlers["chat:send"]({
      conversationId: "general",
      accessToken: alice.accessToken,
      text: "unaffected",
    });

    /* Blocking is about what reaches you. Muting yourself for them as well
     * would be a different feature, and a surprising one. */
    assert.ok(whoGot("general").includes(mallory.serverUserId));

    await unblock(alice, mallory);
  });

  it("keeps their old messages out of history", async () => {
    clearAll();
    await mallory.handlers["chat:send"]({
      conversationId: "general",
      accessToken: mallory.accessToken,
      text: "from before the block",
    });

    await block(alice, mallory);
    clearAll();

    await alice.handlers["chat:fetch"]({ conversationId: "general", limit: 50 });
    const history = alice.received("chat:history")[0] as {
      items: { sender_server_id: string }[];
    };

    assert.ok(
      !history.items.some((m) => m.sender_server_id === mallory.serverUserId),
      "nothing of hers survives the fetch",
    );

    await unblock(alice, mallory);
  });

  it("refuses a direct message in both directions", async () => {
    await block(alice, mallory);

    clearAll();
    await mallory.handlers["dm:open"]({
      accessToken: mallory.accessToken,
      targetServerUserId: alice.serverUserId,
    });
    assert.equal(mallory.received("dm:opened").length, 0, "she cannot open one with Alice");

    clearAll();
    await alice.handlers["dm:open"]({
      accessToken: alice.accessToken,
      targetServerUserId: mallory.serverUserId,
    });
    assert.equal(
      alice.received("dm:opened").length,
      0,
      "and neither can Alice, or the block would be one tap from undone",
    );

    await unblock(alice, mallory);
  });

  it("refuses with the same words somebody who left the server gets", async () => {
    await block(alice, mallory);
    clearAll();

    await mallory.handlers["dm:open"]({
      accessToken: mallory.accessToken,
      targetServerUserId: alice.serverUserId,
    });
    const err = mallory.received("dm:error")[0] as { error: string };

    /* Not its own code. A client that could tell "blocked" from "gone" would
     * eventually say so, and that is the one thing this must never do. */
    assert.equal(err.error, "unknown_member");

    await unblock(alice, mallory);
  });

  it("refuses a group that would put the two of them in it, started by either", async () => {
    await block(alice, mallory);

    await mallory.handlers["dm:group:create"]({
      accessToken: mallory.accessToken,
      memberIds: [alice.serverUserId, bob.serverUserId],
    });
    assert.equal(mallory.received("dm:opened").length, 0, "she put Alice in a group anyway");
    assert.equal((mallory.received("dm:error")[0] as { error?: string } | undefined)?.error, "unknown_member");

    clearAll();
    await alice.handlers["dm:group:create"]({
      accessToken: alice.accessToken,
      memberIds: [mallory.serverUserId, bob.serverUserId],
    });
    assert.equal(alice.received("dm:opened").length, 0, "Alice made a group with somebody she blocked");

    await unblock(alice, mallory);
  });

  it("refuses adding one of them to a group the other is in", async () => {
    const dave = await connectMember("Dave");
    clearAll();
    await bob.handlers["dm:group:create"]({
      accessToken: bob.accessToken,
      memberIds: [mallory.serverUserId, dave.serverUserId],
    });
    const groupId = (bob.received("dm:opened").at(-1) as { conversation_id: string }).conversation_id;

    await block(alice, mallory);
    await mallory.handlers["dm:group:add"]({
      accessToken: mallory.accessToken,
      conversationId: groupId,
      targetServerUserId: alice.serverUserId,
    });
    assert.equal(alice.received("dm:opened").length, 0, "Mallory added Alice after Alice blocked her");
    assert.equal((mallory.received("dm:error")[0] as { error?: string } | undefined)?.error, "unknown_member");

    /* Between the one adding and the one added, like `dm:open`. Bob has no block
     * with Alice, so she can share a group with Mallory the way she shares a channel. */
    clearAll();
    await bob.handlers["dm:group:add"]({
      accessToken: bob.accessToken,
      conversationId: groupId,
      targetServerUserId: alice.serverUserId,
    });
    assert.equal(alice.received("dm:opened").length, 1, "a block between two people stopped a third adding one of them");

    await unblock(alice, mallory);
  });
});

/* Opened before the block, which is the case that matters: a block stops a new
 * one-to-one, so only an old one can still ring. */
describe("what a block stops in calls and typing", () => {
  let pairId: string;
  let groupId: string;

  before(async () => {
    pairId = (await openDirectConversation(alice.serverUserId, mallory.serverUserId)).conversation_id;
    groupId = (await createGroupConversation(bob.serverUserId, [bob.serverUserId, alice.serverUserId, mallory.serverUserId]))
      .conversation_id;
  });

  beforeEach(() => {
    resetRings();
    resetRateLimits();
  });

  after(() => resetRings());

  async function ring(who: Participant, conversationId: string): Promise<void> {
    await who.handlers["call:ring"]({ accessToken: who.accessToken, conversationId });
  }

  function rungIn(who: Participant, conversationId: string): boolean {
    return who.received("call:incoming").some((c) => (c as { conversation_id: string }).conversation_id === conversationId);
  }

  async function roomAnswer(who: Participant, conversationId: string): Promise<unknown> {
    who.clear();
    await who.handlers["voice:room:request"](conversationId);
    return who.received("voice:room:error")[0];
  }

  function typingFrom(who: Participant, from: Participant): unknown[] {
    return who.received("chat:typing").filter((t) => (t as { serverUserId: string }).serverUserId === from.serverUserId);
  }

  it("keeps their ring from reaching the blocker, and tells them nothing", async () => {
    await block(alice, mallory);
    await ring(mallory, pairId);

    assert.ok(!rungIn(alice, pairId), "Alice's phone rang");
    assert.equal(mallory.received("call:error").length, 0, "Mallory was told something went wrong");
    assert.equal(mallory.received("call:ringing").length, 1, "and her own side rings, as for anybody who does not pick up");

    await unblock(alice, mallory);
  });

  it("keeps the blocker's ring from them in a one-to-one", async () => {
    await block(alice, mallory);
    await ring(alice, pairId);

    assert.ok(!rungIn(mallory, pairId), "Alice rang somebody she blocked");

    await unblock(alice, mallory);
  });

  it("rings the rest of a group, and not the blocker", async () => {
    await block(alice, mallory);
    await ring(mallory, groupId);

    assert.ok(rungIn(bob, groupId), "Bob, who blocked nobody, is rung");
    assert.ok(!rungIn(alice, groupId), "Alice is not");

    await unblock(alice, mallory);
  });

  it("rings again once unblocked", async () => {
    await block(alice, mallory);
    await unblock(alice, mallory);
    await ring(mallory, pairId);

    assert.ok(rungIn(alice, pairId));
  });

  it("refuses the one-to-one call room both ways, with the answer a stranger gets", async () => {
    await block(alice, mallory);

    const stranger = await roomAnswer(bob, pairId);
    assert.deepEqual(await roomAnswer(mallory, pairId), stranger, "Mallory joined the call room of somebody who blocked her");
    assert.deepEqual(await roomAnswer(alice, pairId), stranger, "Alice joined a call with somebody she blocked");

    await unblock(alice, mallory);
    assert.notDeepEqual(await roomAnswer(mallory, pairId), stranger, "and unblocking lets her back in");
  });

  it("leaves a group's call room open, as its messages are", async () => {
    await block(alice, mallory);

    const answer = (await roomAnswer(mallory, groupId)) as { error?: string } | string | undefined;
    assert.notEqual(typeof answer === "object" ? answer?.error : answer, "not_found");

    await unblock(alice, mallory);
  });

  it("keeps their typing from the blocker, in a one-to-one and in a channel", async () => {
    await block(alice, mallory);

    for (const conversationId of [pairId, "general"]) {
      await mallory.handlers["chat:typing"]({ conversationId });
      await mallory.handlers["chat:stop_typing"]({ conversationId });
    }

    assert.equal(typingFrom(alice, mallory).length, 0, "Alice saw Mallory typing");
    assert.equal(alice.received("chat:stop_typing").length, 0);
    assert.equal(typingFrom(bob, mallory).length, 1, "Bob still sees her typing in the channel");

    await unblock(alice, mallory);
  });

  it("does not stop the blocker's typing being seen", async () => {
    await block(alice, mallory);

    await alice.handlers["chat:typing"]({ conversationId: pairId });
    await alice.handlers["chat:stop_typing"]({ conversationId: pairId });
    assert.equal(typingFrom(mallory, alice).length, 1);

    await unblock(alice, mallory);
  });
});

describe("unblocking", () => {
  it("lets their messages through again", async () => {
    await block(alice, mallory);
    await unblock(alice, mallory);
    clearAll();

    await mallory.handlers["chat:send"]({
      conversationId: "general",
      accessToken: mallory.accessToken,
      text: "back again",
    });

    assert.ok(whoGot("general").includes(alice.serverUserId));
  });

  it("empties the list", async () => {
    await block(alice, mallory);
    await unblock(alice, mallory);
    clearAll();

    await alice.handlers["user:blocks:list"]({ accessToken: alice.accessToken });
    const list = alice.received("user:blocks")[0] as { blocked: unknown[] };
    assert.equal(list.blocked.length, 0);
  });

  it("is harmless when there was no block", async () => {
    clearAll();
    await alice.handlers["user:unblock"]({
      accessToken: alice.accessToken,
      serverUserId: bob.serverUserId,
    });

    const errors = alice.received("server:error");
    assert.equal(errors.length, 0, "no error for undoing something that was not done");
  });
});

/* GRYT-1477. The join check only runs on a join, so a call already going when one of
 * them blocks the other has to be ended by the block itself. */
describe("a block during a call", () => {
  let pairId: string;
  let groupId: string;

  before(async () => {
    pairId = (await openDirectConversation(alice.serverUserId, mallory.serverUserId)).conversation_id;
    groupId = (await createGroupConversation(bob.serverUserId, [bob.serverUserId, alice.serverUserId, mallory.serverUserId]))
      .conversation_id;
  });

  beforeEach(() => {
    resetRings();
    resetRateLimits();
  });

  afterEach(async () => {
    for (const who of [alice, bob, mallory]) leaveCall(who);
    await unblock(alice, mallory);
  });

  /** What a socket looks like once `voice:channel:joined` has run for this room. */
  function inCall(who: Participant, roomId: string): void {
    Object.assign(world.clientsInfo[who.clientId], {
      hasJoinedChannel: true,
      isConnectedToVoice: true,
      voiceChannelId: roomId,
      streamID: `stream-${who.clientId}`,
    });
  }

  function leaveCall(who: Participant): void {
    Object.assign(world.clientsInfo[who.clientId], { hasJoinedChannel: false, isConnectedToVoice: false, voiceChannelId: "", streamID: "" });
  }

  /** An SFU that records what the server asks of it. */
  function fakeSfu() {
    const calls = { disconnected: [] as string[][], hidden: [] as { roomId: string; userId: string; hidden: string[] }[] };
    const sfuClient = {
      disconnectUser: async (roomId: string, userId: string) => {
        calls.disconnected.push([roomId, userId]);
      },
      untrackUserConnection() {},
      setHiddenPeers: async (roomId: string, userId: string, hidden: string[]) => {
        calls.hidden.push({ roomId, userId, hidden });
      },
    };
    return { calls, sfuClient: sfuClient as unknown as HandlerContext["sfuClient"] };
  }

  async function blockWith(sfuClient: HandlerContext["sfuClient"], who: Participant, whom: Participant, event = "user:block") {
    clearAll();
    await registerBlockHandlers({ ...who.ctx, sfuClient })[event]({ accessToken: who.accessToken, serverUserId: whom.serverUserId });
  }

  function toldToLeave(who: Participant): boolean {
    return who.received("voice:room:leave").length === 1 && who.received("voice:channel:joined").includes(false);
  }

  it("ends a one-to-one call for both of them", async () => {
    inCall(alice, pairId);
    inCall(mallory, pairId);
    const { calls, sfuClient } = fakeSfu();

    await blockWith(sfuClient, alice, mallory);

    for (const who of [alice, mallory]) {
      const ci = world.clientsInfo[who.clientId];
      assert.equal(ci.hasJoinedChannel, false, `${ci.nickname} is still in the call`);
      assert.equal(ci.voiceChannelId, "");
      assert.ok(toldToLeave(who), `${ci.nickname} was not told the call ended`);
    }
    assert.deepEqual(
      calls.disconnected.map(([, userId]) => userId).sort(),
      [alice.serverUserId, mallory.serverUserId].sort(),
      "the SFU was not told to drop both of them",
    );
    // Told the call ended, and nothing that says why.
    assert.equal(mallory.received("user:blocked").length, 0);
    assert.equal(mallory.received("voice:kicked").length, 0);
  });

  it("ends it when the one blocked is the one who blocks back, too", async () => {
    inCall(alice, pairId);
    inCall(mallory, pairId);
    await blockWith(null, mallory, alice);

    assert.equal(world.clientsInfo[alice.clientId].hasJoinedChannel, false);
    assert.equal(world.clientsInfo[mallory.clientId].hasJoinedChannel, false);
    await unblock(mallory, alice);
  });

  it("withdraws a ring between them, on both sides", async () => {
    await mallory.handlers["call:ring"]({ accessToken: mallory.accessToken, conversationId: pairId });
    assert.ok(alice.received("call:incoming").length > 0, "the ring never started");

    await blockWith(null, alice, mallory);

    for (const who of [alice, mallory]) {
      const withdrawn = who.received("call:withdrawn") as { conversation_id: string; reason: string; ended_by: string | null }[];
      assert.deepEqual(withdrawn, [{ conversation_id: pairId, reason: "cancelled", ended_by: null }]);
    }
  });

  it("leaves somebody else's one-to-one alone", async () => {
    const aliceBob = (await openDirectConversation(alice.serverUserId, bob.serverUserId)).conversation_id;
    inCall(alice, aliceBob);
    inCall(bob, aliceBob);

    await blockWith(null, alice, mallory);

    assert.equal(world.clientsInfo[alice.clientId].voiceChannelId, aliceBob);
    assert.equal(world.clientsInfo[bob.clientId].hasJoinedChannel, true);
  });

  it("keeps both in a group call, and has the SFU stop sending the blocker their media", async () => {
    inCall(alice, groupId);
    inCall(mallory, groupId);
    const { calls, sfuClient } = fakeSfu();

    await blockWith(sfuClient, alice, mallory);

    assert.equal(world.clientsInfo[alice.clientId].voiceChannelId, groupId);
    assert.equal(world.clientsInfo[mallory.clientId].voiceChannelId, groupId);
    assert.equal(calls.disconnected.length, 0);
    assert.deepEqual(calls.hidden, [{ roomId: `block-test_${groupId}`, userId: alice.serverUserId, hidden: [mallory.serverUserId] }]);

    // Only the blocker's list: Mallory still gets Alice, as blocking is about what reaches you.
    await blockWith(sfuClient, alice, mallory, "user:unblock");
    assert.deepEqual(calls.hidden.at(-1), { roomId: `block-test_${groupId}`, userId: alice.serverUserId, hidden: [] });
  });

  it("sends the list when the blocker joins a group call", async () => {
    await block(alice, mallory);
    world.clientsInfo[alice.clientId].voiceChannelId = groupId;
    const { calls, sfuClient } = fakeSfu();

    await registerVoiceHandlers({ ...alice.ctx, sfuClient })["voice:channel:joined"](true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(world.clientsInfo[alice.clientId].hasJoinedChannel, true, `the join was refused: ${JSON.stringify(alice.received("voice:room:error"))}`);
    assert.deepEqual(calls.hidden, [{ roomId: `block-test_${groupId}`, userId: alice.serverUserId, hidden: [mallory.serverUserId] }]);
  });
});
