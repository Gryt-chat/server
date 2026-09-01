import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { registerChatHandlers } from "./chat";
import { registerDirectMessageHandlers } from "./dm";
import { registerBlockHandlers } from "./blocks";
import { upsertServerChannel } from "../../db/sqlite/channels";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Blocking, driven through the handlers rather than around them.
 *
 * The queries in `db/sqlite/blocks.ts` can be right while nothing asks them,
 * which is the failure this file exists to catch: a block that is recorded and
 * then changes nothing is worse than no block at all, because the person who
 * used it believes they are covered.
 *
 * So every case here is about who received something. Three participants share
 * one `clientsInfo` and one `io.sockets.sockets` map, which is what makes "did
 * this reach them" an assertion rather than a hope.
 *
 * Mallory is a member in good standing throughout. Nothing here is a
 * permission: blocking has to work against somebody who outranks you, and none
 * of these cases give anybody a role.
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
  const grytUserId = grytUserIdOverride ?? `account-block-${seq}`;
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
