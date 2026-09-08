import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { directConversationId, openDirectConversation } from "../../db/sqlite/conversations";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { buildMemberList, memberStateHash } from "../utils/clients";
import { resetChannelIdCache } from "../utils/conversationAccess";
import type { EventHandlerMap, HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * A DM's id is a hash of the sorted pair and is not a secret, so naming one
 * proves nothing and this handler has to ask who is in it. The member list is
 * asserted on too, since a gated call still leaks if the id is announced.
 */

const HOST = "voiceroom.test:5001";

let dir: string;

interface Emitted {
  event: string;
  payload: unknown;
}

interface Caller {
  clientId: string;
  serverUserId: string;
  emitted: Emitted[];
  handlers: EventHandlerMap;
  clear: () => void;
}

const clientsInfo: Clients = {};

const io = {
  to() {
    return { emit() {} };
  },
  emit() {},
  sockets: { sockets: new Map() },
};

let seq = 0;

async function connectMember(nickname: string, roleId = "member"): Promise<Caller> {
  seq += 1;
  const clientId = `voice-socket-${seq}`;
  const grytUserId = `account-voice-${seq}`;
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

  const ctx = {
    io,
    socket,
    clientId,
    serverId: "voice-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.1.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    clientId,
    serverUserId: user.server_user_id,
    emitted,
    handlers: registerVoiceHandlers(ctx),
    clear: () => {
      emitted.length = 0;
    },
  };
}

/** The `voice:room:error` payloads this socket received, as objects. */
function errors(caller: Caller): { error?: string; message?: string }[] {
  return caller.emitted
    .filter((e) => e.event === "voice:room:error")
    .map((e) => (typeof e.payload === "string" ? { message: e.payload } : (e.payload as { error?: string })));
}

/** Whether the request was turned away as not theirs, rather than reaching the SFU. */
function refusedAsNotFound(caller: Caller): boolean {
  return errors(caller).some((e) => e.error === "not_found");
}

let alice: Caller;
let bob: Caller;
let mallory: Caller;
let pairId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-voiceroom-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: "general", name: "general", type: "voice" });
  resetChannelIdCache();

  alice = await connectMember("Alice");
  bob = await connectMember("Bob");
  mallory = await connectMember("Mallory");

  await openDirectConversation(alice.serverUserId, bob.serverUserId);
  pairId = directConversationId(alice.serverUserId, bob.serverUserId);
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("voice:room:request decides which rooms are yours", () => {
  it("lets a member into a channel on this server", async () => {
    alice.clear();
    await alice.handlers["voice:room:request"]("general");
    assert.equal(refusedAsNotFound(alice), false);
  });

  it("lets somebody into their own conversation", async () => {
    alice.clear();
    await alice.handlers["voice:room:request"](pairId);
    assert.equal(refusedAsNotFound(alice), false);
  });

  it("keeps a third person out of a conversation that is not theirs", async () => {
    // Mallory holds every permission Alice does and is only missing being in the
    // conversation, whose id she can work out from the member list.
    mallory.clear();
    await mallory.handlers["voice:room:request"](pairId);
    assert.equal(refusedAsNotFound(mallory), true);
  });

  it("refuses a room that is neither a channel nor a conversation", async () => {
    alice.clear();
    await alice.handlers["voice:room:request"]("dm_madeup00000000000000000000000000");
    assert.equal(refusedAsNotFound(alice), true);

    alice.clear();
    await alice.handlers["voice:room:request"]("not-a-channel");
    assert.equal(refusedAsNotFound(alice), true);
  });

  it("says the same thing for a conversation that is not yours and one that does not exist", async () => {
    // Telling them apart would answer "do these two people have a conversation
    // open" for anybody who can name the pair, which is everybody.
    mallory.clear();
    await mallory.handlers["voice:room:request"](pairId);
    const notMine = errors(mallory).map((e) => e.message);

    mallory.clear();
    await mallory.handlers["voice:room:request"]("dm_absent000000000000000000000000000");
    const notThere = errors(mallory).map((e) => e.message);

    assert.deepEqual(notMine, notThere);
  });
});

describe("a conversation never reaches the server-wide member list", () => {
  it("names a channel somebody is in", async () => {
    clientsInfo[alice.clientId].voiceChannelId = "general";
    clientsInfo[alice.clientId].hasJoinedChannel = true;

    const members = await buildMemberList(clientsInfo);
    const row = members.find((m) => m.serverUserId === alice.serverUserId);
    assert.equal(row?.voiceChannelId, "general");
  });

  it("does not name the conversation somebody is calling in", async () => {
    clientsInfo[alice.clientId].voiceChannelId = pairId;
    clientsInfo[alice.clientId].hasJoinedChannel = true;

    const members = await buildMemberList(clientsInfo);
    const row = members.find((m) => m.serverUserId === alice.serverUserId);

    assert.equal(row?.voiceChannelId, "");
    // Still visibly busy. That much everybody is allowed to know — it is who
    // with that has to stay in the conversation.
    assert.equal(row?.hasJoinedChannel, true);
  });

  it("keeps the id out of the dedupe hash as well", async () => {
    // The hash decides whether a broadcast goes out, so an id left in it is a
    // second copy of the leak and repaints every client on every move.
    clientsInfo[alice.clientId].voiceChannelId = pairId;
    const inOneCall = memberStateHash(await buildMemberList(clientsInfo));

    clientsInfo[alice.clientId].voiceChannelId = directConversationId(
      alice.serverUserId,
      mallory.serverUserId,
    );
    const inAnother = memberStateHash(await buildMemberList(clientsInfo));

    assert.equal(inOneCall, inAnother);
    assert.equal(inOneCall.includes(pairId), false);
  });
});
