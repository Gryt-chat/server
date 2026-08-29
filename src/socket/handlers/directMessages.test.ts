import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BOT_SUB_PREFIX } from "../../auth/identity";
import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole, updateServerConfig } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { registerChatHandlers } from "./chat";
import { registerDirectMessageHandlers } from "./dm";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Direct messages, driven through the handlers rather than around them.
 *
 * `conversationAccess.test.ts` proves the access rule answers correctly. It
 * cannot prove the handlers ask it, and it says nothing at all about who the
 * answer is then sent to — a handler that resolves access perfectly and then
 * broadcasts to every socket passes every test in that file. Reactions and
 * deletions did exactly that until GRYT-671, so this is the file that would
 * notice them going back.
 *
 * Three participants, each with their own socket, all sharing one `clientsInfo`
 * and one `io.sockets.sockets` map — which is what makes "who received this"
 * an assertion rather than a hope. Mallory is a member of the server in good
 * standing throughout. Every refusal she gets is about the conversation.
 */

const HOST = "dm.test:5001";

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
  const sockets = new Map<string, { emit: (event: string, payload?: unknown) => boolean }>();

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

/**
 * A member of this server, connected, holding the default member permissions.
 *
 * `hasJoinedChannel` and the rest of the voice fields are what a socket looks
 * like once a join has finished; the chat handlers read `serverUserId` off this
 * and nothing else here matters to them.
 */
async function connectMember(nickname: string, grytUserIdOverride?: string): Promise<Participant> {
  seq += 1;
  const clientId = `socket-${seq}`;
  const grytUserId = grytUserIdOverride ?? `account-dm-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");

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
    to() {
      return { emit() {} };
    },
  };

  world.sockets.set(clientId, {
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
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

  const ctx = {
    io: world.io,
    socket,
    clientId,
    serverId: "dm-test",
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
    handlers: { ...registerChatHandlers(ctx), ...registerDirectMessageHandlers(ctx) },
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
  dir = mkdtempSync(join(tmpdir(), "gryt-dm-"));
  process.env.DATA_DIR = dir;
  // requireAuth refuses everything without a config row, which would make every
  // case below pass for the wrong reason.
  await initSqlite();
  await createServerConfigIfNotExists();
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

/** The conversation between the two, by way of the handler that makes it. */
async function openDm(from: Participant, to: Participant): Promise<string> {
  clearAll();
  await from.handlers["dm:open"]({
    accessToken: from.accessToken,
    targetServerUserId: to.serverUserId,
  });
  const opened = from.received("dm:opened")[0] as { conversation_id?: string } | undefined;
  assert.ok(opened?.conversation_id, `dm:open told ${from.serverUserId} nothing: ${JSON.stringify(from.emitted)}`);
  return opened.conversation_id;
}

describe("opening a direct message", () => {
  it("tells both ends, and tells each of them about the other", async () => {
    const conversationId = await openDm(alice, bob);

    const toAlice = alice.received("dm:opened")[0] as { other: { nickname: string } };
    const toBob = bob.received("dm:opened")[0] as { conversation_id: string; other: { nickname: string } };

    assert.equal(toAlice.other.nickname, "Bob");
    assert.equal(toBob.other.nickname, "Alice", "Bob is told who Alice is, not who he is");
    assert.equal(toBob.conversation_id, conversationId, "both ends agree on the id");
  });

  it("does not make a second one, from either side", async () => {
    const first = await openDm(alice, bob);
    const second = await openDm(bob, alice);
    assert.equal(first, second);

    clearAll();
    await alice.handlers["dm:list"]({ accessToken: alice.accessToken });
    const list = alice.received("dm:list")[0] as { items: unknown[] };
    assert.equal(list.items.length, 1, "one conversation after opening it three times");
  });

  it("refuses a stranger, a bot and yourself", async () => {
    const cases: [string, string][] = [
      ["somebody who was never here", "srv_nobody"],
      ["yourself", alice.serverUserId],
    ];

    for (const [label, target] of cases) {
      clearAll();
      await alice.handlers["dm:open"]({ accessToken: alice.accessToken, targetServerUserId: target });
      assert.equal(alice.received("dm:opened").length, 0, `opened one with ${label}`);
      assert.ok(alice.received("dm:error").length > 0, `no refusal for ${label}`);
    }

    // Bots carry a reserved `sub` prefix, so this is the id doing the work
    // rather than a flag somebody could forget to set.
    // The constant rather than the literal: the prefix is `BOT_`, and a test
    // that spelled it itself would go green against a server that had stopped
    // recognising bots at all.
    const bot = await connectMember("Botty", `${BOT_SUB_PREFIX}probe-1`);
    clearAll();
    await alice.handlers["dm:open"]({ accessToken: alice.accessToken, targetServerUserId: bot.serverUserId });
    assert.equal(alice.received("dm:opened").length, 0, "opened one with a bot");
  });
});

describe("who a direct message reaches", () => {
  it("delivers a message to both members and to nobody else", async () => {
    const conversationId = await openDm(alice, bob);
    clearAll();

    await alice.handlers["chat:send"]({
      conversationId,
      accessToken: alice.accessToken,
      text: "just between us",
    });

    const delivered = (p: Participant) =>
      p.received("chat:new").filter((m) => (m as { text?: string }).text === "just between us");

    assert.equal(delivered(alice).length, 1, "the sender sees it");
    assert.equal(delivered(bob).length, 1, "the other member sees it");
    assert.equal(delivered(mallory).length, 0, "a non-member does not");
  });

  it("keeps a reaction inside the conversation", async () => {
    // This one and the deletion below used to be `io.emit`, which told the
    // whole server that a message it could not read had been reacted to.
    const conversationId = await openDm(alice, bob);
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "react to me" });

    const sent = alice.received("chat:new").at(-1) as { message_id: string };
    clearAll();

    await bob.handlers["chat:react"]({
      conversationId,
      messageId: sent.message_id,
      reactionSrc: "👍",
      accessToken: bob.accessToken,
    });

    assert.equal(alice.received("chat:reaction").length, 1);
    assert.equal(bob.received("chat:reaction").length, 1);
    assert.equal(mallory.received("chat:reaction").length, 0, "a non-member heard about the reaction");
  });

  it("keeps a deletion inside the conversation", async () => {
    const conversationId = await openDm(alice, bob);
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "delete me" });

    const sent = alice.received("chat:new").at(-1) as { message_id: string };
    clearAll();

    await alice.handlers["chat:delete"]({
      conversationId,
      messageId: sent.message_id,
      accessToken: alice.accessToken,
    });

    assert.equal(alice.received("chat:deleted").length, 1);
    assert.equal(bob.received("chat:deleted").length, 1);
    assert.equal(mallory.received("chat:deleted").length, 0, "a non-member heard about the deletion");
  });

  it("refuses to hand the history to somebody who is not in it", async () => {
    const conversationId = await openDm(alice, bob);
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "private" });
    clearAll();

    // Mallory can compute this id herself — it is derived from two ids the
    // member list gives her. Knowing it is not supposed to be worth anything.
    await mallory.handlers["chat:fetch"]({ conversationId });

    assert.equal(mallory.received("chat:history").length, 0, "history handed to a non-member");
    assert.ok(mallory.received("chat:error").length > 0, "no refusal");
  });

  it("lets a member read the history back", async () => {
    const conversationId = await openDm(alice, bob);
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "for the record" });
    clearAll();

    await bob.handlers["chat:fetch"]({ conversationId });
    const history = bob.received("chat:history")[0] as { items: { text: string }[] } | undefined;
    assert.ok(history, "a member was refused their own conversation");
    assert.ok(history.items.some((m) => m.text === "for the record"));
  });
});

describe("a server with direct messages turned off", () => {
  it("refuses to open one or to post to one, and still serves the history", async () => {
    const conversationId = await openDm(alice, bob);
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "before the switch" });

    await updateServerConfig({ allowDms: false });
    clearAll();

    await alice.handlers["dm:open"]({ accessToken: alice.accessToken, targetServerUserId: mallory.serverUserId });
    assert.equal(alice.received("dm:opened").length, 0, "opened one while switched off");

    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "after the switch" });
    assert.equal(
      bob.received("chat:new").filter((m) => (m as { text?: string }).text === "after the switch").length,
      0,
      "delivered a message while switched off",
    );

    // The point of the setting being a refusal rather than a deletion: what was
    // already said is still readable, so turning it back on undoes nothing.
    clearAll();
    await bob.handlers["chat:fetch"]({ conversationId });
    const history = bob.received("chat:history")[0] as { items: { text: string }[] } | undefined;
    assert.ok(history, "history refused while switched off");
    assert.ok(history.items.some((m) => m.text === "before the switch"));

    await updateServerConfig({ allowDms: true });
  });
});

describe("channels are untouched by any of this", () => {
  it("still reaches everybody in the server", async () => {
    // The same handler decides both, so a rule written for DMs that quietly
    // narrowed channel delivery would show up here and nowhere else.
    const { upsertServerChannel } = await import("../../db/sqlite/channels");
    await upsertServerChannel({ channelId: "town-square", name: "Town Square", type: "text" });
    resetChannelIdCache();
    clearAll();

    await alice.handlers["chat:send"]({
      conversationId: "town-square",
      accessToken: alice.accessToken,
      text: "everybody",
    });

    for (const who of [alice, bob, mallory]) {
      assert.equal(
        who.received("chat:new").filter((m) => (m as { text?: string }).text === "everybody").length,
        1,
        `${who.serverUserId} missed a channel message`,
      );
    }
  });
});
