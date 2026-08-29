import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BOT_SUB_PREFIX } from "../../auth/identity";
import { initSqlite } from "../../db/sqlite/connection";
import { BUILT_IN_ROLES } from "../../constants/permissions";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
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
async function connectMember(
  nickname: string,
  grytUserIdOverride?: string,
  roleId = "member",
): Promise<Participant> {
  seq += 1;
  const clientId = `socket-${seq}`;
  const grytUserId = grytUserIdOverride ?? `account-dm-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, roleId);

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

describe("a role that may talk in channels but not in private", () => {
  it("cannot open one, cannot post in one, and can still read it", async () => {
    // Everything a member has except the one permission. The point of splitting
    // it out was that this combination is expressible at all.
    await createRoleDefinition("channels-only", {
      name: "Channels only",
      rank: 30,
      permissions: (BUILT_IN_ROLES.find((r) => r.id === "member")?.permissions ?? []).filter(
        (p) => p !== "send_direct_messages",
      ),
    });
    const carl = await connectMember("Carl", undefined, "channels-only");

    clearAll();
    carl.clear();
    await carl.handlers["dm:open"]({
      accessToken: carl.accessToken,
      targetServerUserId: alice.serverUserId,
    });
    assert.equal(carl.received("dm:opened").length, 0, "opened one without the permission");

    // Alice may, so the conversation exists and Carl is party to it. Gating only
    // `dm:open` would leave this one open to him for good.
    clearAll();
    carl.clear();
    await alice.handlers["dm:open"]({
      accessToken: alice.accessToken,
      targetServerUserId: carl.serverUserId,
    });
    const conversationId = (alice.received("dm:opened")[0] as { conversation_id: string }).conversation_id;
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "you can read this" });

    carl.clear();
    await carl.handlers["chat:send"]({ conversationId, accessToken: carl.accessToken, text: "but not this" });
    assert.equal(
      alice.received("chat:new").filter((m) => (m as { text?: string }).text === "but not this").length,
      0,
      "posted into a DM without the permission",
    );

    carl.clear();
    await carl.handlers["chat:fetch"]({ conversationId });
    const history = carl.received("chat:history")[0] as { items: { text: string }[] } | undefined;
    assert.ok(history, "reading was refused, and it should not be");
    assert.ok(
      history.items.some((m) => m.text === "you can read this"),
      "losing the permission hid history that was already there",
    );
  });
});

describe("hiding a conversation", () => {
  /** What this member's sidebar would show right now. */
  async function listFor(who: Participant): Promise<string[]> {
    who.clear();
    await who.handlers["dm:list"]({ accessToken: who.accessToken });
    const list = who.received("dm:list")[0] as { items: { conversation_id: string }[] };
    return list.items.map((i) => i.conversation_id);
  }

  async function hide(who: Participant, conversationId: string, hidden: boolean): Promise<void> {
    await who.handlers["dm:setHidden"]({
      accessToken: who.accessToken,
      conversationId,
      hidden,
    });
  }

  it("takes it out of your list and leaves theirs alone", async () => {
    // The whole point of the feature, and the thing most likely to be got
    // wrong: `hidden_at` is on the membership row, so it is one person's
    // answer. A column on `conversations` would have hidden it for both.
    const conversationId = await openDm(alice, bob);

    await hide(alice, conversationId, true);

    assert.equal((await listFor(alice)).includes(conversationId), false, "still in Alice's list");
    assert.equal((await listFor(bob)).includes(conversationId), true, "hiding took it off Bob's too");
  });

  it("keeps every message", async () => {
    const conversationId = await openDm(alice, bob);
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "still here" });

    await hide(alice, conversationId, true);

    clearAll();
    await alice.handlers["chat:fetch"]({ conversationId });
    const history = alice.received("chat:history")[0] as { items: { text: string }[] } | undefined;
    assert.ok(history, "hiding took the history away, and it must not");
    assert.ok(history.items.some((m) => m.text === "still here"));
  });

  it("comes back when they say something", async () => {
    // Otherwise hiding is a way to never hear from somebody again, and the
    // only sign would be an unread count on a row that is not there.
    const conversationId = await openDm(alice, bob);
    await hide(alice, conversationId, true);
    assert.equal((await listFor(alice)).includes(conversationId), false);

    clearAll();
    await bob.handlers["chat:send"]({ conversationId, accessToken: bob.accessToken, text: "you there?" });

    // Read before `listFor`, which clears what the socket has seen.
    const toldAlice = alice.received("dm:opened").some(
      (v) => (v as { conversation_id?: string }).conversation_id === conversationId,
    );

    assert.equal((await listFor(alice)).includes(conversationId), true, "stayed hidden through a new message");
    assert.ok(toldAlice, "Alice was never told it came back, so her sidebar would not know");
  });

  it("comes back when you open it again", async () => {
    const conversationId = await openDm(alice, bob);
    await hide(alice, conversationId, true);

    await alice.handlers["dm:open"]({ accessToken: alice.accessToken, targetServerUserId: bob.serverUserId });

    assert.equal((await listFor(alice)).includes(conversationId), true);
  });

  it("can be put back by hand", async () => {
    const conversationId = await openDm(alice, bob);
    await hide(alice, conversationId, true);
    await hide(alice, conversationId, false);

    assert.equal((await listFor(alice)).includes(conversationId), true);
  });

  it("refuses a conversation that is not yours", async () => {
    const conversationId = await openDm(alice, bob);
    clearAll();

    await hide(mallory, conversationId, true);

    assert.ok(mallory.received("dm:error").length > 0, "no refusal");
    assert.equal((await listFor(alice)).includes(conversationId), true, "Mallory hid somebody else's conversation");
    assert.equal((await listFor(bob)).includes(conversationId), true);
  });
});

describe("group conversations", () => {
  async function listFor(who: Participant): Promise<{ conversation_id: string; kind: string; members: { nickname: string }[]; name: string | null; icon_file_id: string | null }[]> {
    who.clear();
    await who.handlers["dm:list"]({ accessToken: who.accessToken });
    const list = who.received("dm:list")[0] as { items: { conversation_id: string; kind: string; members: { nickname: string }[]; name: string | null; icon_file_id: string | null }[] };
    return list.items;
  }

  async function makeGroup(): Promise<string> {
    clearAll();
    await alice.handlers["dm:group:create"]({
      accessToken: alice.accessToken,
      memberIds: [bob.serverUserId, mallory.serverUserId],
    });
    const opened = alice.received("dm:opened").at(-1) as { conversation_id?: string } | undefined;
    assert.ok(opened?.conversation_id, `no group came back: ${JSON.stringify(alice.emitted)}`);
    return opened.conversation_id;
  }

  it("takes three people and tells all of them", async () => {
    const conversationId = await makeGroup();

    for (const who of [alice, bob, mallory]) {
      const view = (await listFor(who)).find((c) => c.conversation_id === conversationId);
      assert.ok(view, `${who.serverUserId} cannot see the group`);
      assert.equal(view.kind, "group");
      assert.equal(view.members.length, 2, "each of them sees the other two");
    }
  });

  it("does not swallow the one-to-one those people already had", async () => {
    // The decision this feature turns on. Adding somebody to a pair
    // conversation would make its history readable by a third person, so
    // making a group makes a *new* conversation and leaves the pair alone.
    const pairId = await openDm(alice, bob);
    await alice.handlers["chat:send"]({ conversationId: pairId, accessToken: alice.accessToken, text: "just us" });

    const groupId = await makeGroup();
    assert.notEqual(groupId, pairId);

    const forAlice = await listFor(alice);
    assert.ok(forAlice.some((c) => c.conversation_id === pairId), "the pair conversation went missing");
    assert.ok(forAlice.some((c) => c.conversation_id === groupId));

    clearAll();
    await alice.handlers["chat:fetch"]({ conversationId: pairId });
    const history = alice.received("chat:history")[0] as { items: { text: string }[] } | undefined;
    assert.ok(history?.items.some((m) => m.text === "just us"), "the pair history was lost");

    // And the third person cannot reach it.
    clearAll();
    await mallory.handlers["chat:fetch"]({ conversationId: pairId });
    assert.equal(mallory.received("chat:history").length, 0, "a group member could read the pair history");
  });

  it("delivers to everybody in it and nobody outside it", async () => {
    const conversationId = await makeGroup();
    const outsider = await connectMember("Outsider");
    clearAll();
    outsider.clear();

    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "all three" });

    const got = (p: Participant) =>
      p.received("chat:new").filter((m) => (m as { text?: string }).text === "all three").length;
    assert.equal(got(alice), 1);
    assert.equal(got(bob), 1);
    assert.equal(got(mallory), 1);
    assert.equal(got(outsider), 0, "somebody outside the group received it");
  });

  it("lets anybody in it add somebody, and the new person sees it", async () => {
    const conversationId = await makeGroup();
    const dave = await connectMember("Dave");

    // Bob, not Alice. There is no owner; anybody in the group may add.
    await bob.handlers["dm:group:add"]({
      accessToken: bob.accessToken,
      conversationId,
      targetServerUserId: dave.serverUserId,
    });

    assert.ok(
      (await listFor(dave)).some((c) => c.conversation_id === conversationId),
      "the person added cannot see the group",
    );
  });

  it("stops delivering once you leave", async () => {
    const conversationId = await makeGroup();

    await mallory.handlers["dm:group:leave"]({ accessToken: mallory.accessToken, conversationId });
    assert.equal(
      (await listFor(mallory)).some((c) => c.conversation_id === conversationId),
      false,
      "still listed after leaving",
    );

    clearAll();
    await alice.handlers["chat:send"]({ conversationId, accessToken: alice.accessToken, text: "after she left" });
    assert.equal(
      mallory.received("chat:new").filter((m) => (m as { text?: string }).text === "after she left").length,
      0,
      "a message reached somebody who had left",
    );
    // Leaving is not hiding: it does not come back.
    assert.equal((await listFor(mallory)).some((c) => c.conversation_id === conversationId), false);
  });

  it("refuses a group with fewer than two other people", async () => {
    clearAll();
    await alice.handlers["dm:group:create"]({
      accessToken: alice.accessToken,
      memberIds: [bob.serverUserId],
    });
    assert.equal(alice.received("dm:opened").length, 0, "made a two-person group");
    assert.ok(alice.received("dm:error").length > 0);
  });

  it("refuses somebody who is not in it", async () => {
    const conversationId = await makeGroup();
    const outsider = await connectMember("Nosy");
    outsider.clear();

    await outsider.handlers["dm:group:add"]({
      accessToken: outsider.accessToken,
      conversationId,
      targetServerUserId: outsider.serverUserId,
    });
    assert.ok(outsider.received("dm:error").length > 0, "an outsider added themselves");
    assert.equal((await listFor(outsider)).some((c) => c.conversation_id === conversationId), false);
  });

  it("can be given a picture, and clearing it goes back to the drawn one", async () => {
    const conversationId = await makeGroup();

    await alice.handlers["dm:group:update"]({
      accessToken: alice.accessToken,
      conversationId,
      iconFileId: "file_abc123",
    });
    let view = (await listFor(bob)).find((c) => c.conversation_id === conversationId) as
      | { icon_file_id?: string | null }
      | undefined;
    assert.equal(view?.icon_file_id, "file_abc123", "the upload did not reach the other members");

    await alice.handlers["dm:group:update"]({
      accessToken: alice.accessToken,
      conversationId,
      iconFileId: null,
    });
    view = (await listFor(bob)).find((c) => c.conversation_id === conversationId) as
      | { icon_file_id?: string | null }
      | undefined;
    // Null is "draw it from the name", not "no picture" — the clients render
    // the generated one, so nothing needs storing for it.
    assert.equal(view?.icon_file_id, null);
  });

  it("can be named, and the name reaches everybody", async () => {
    const conversationId = await makeGroup();

    await alice.handlers["dm:group:update"]({
      accessToken: alice.accessToken,
      conversationId,
      name: "  Weekend plans  ",
    });

    for (const who of [alice, bob, mallory]) {
      const view = (await listFor(who)).find((c) => c.conversation_id === conversationId);
      assert.equal(view?.name, "Weekend plans", `${who.serverUserId} did not get the name`);
    }
  });

  it("refuses leaving a one-to-one, which is what hiding is for", async () => {
    const pairId = await openDm(alice, bob);
    clearAll();

    await alice.handlers["dm:group:leave"]({ accessToken: alice.accessToken, conversationId: pairId });

    assert.ok(alice.received("dm:error").length > 0);
    assert.ok((await listFor(alice)).some((c) => c.conversation_id === pairId), "the pair conversation was left");
  });
});
