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
 * Which rooms `voice:room:request` will hand an SFU token for.
 *
 * The handler used to grant any string. That was survivable while every room id
 * was a channel — a channel is open to every member of the server, so "may this
 * person use voice" and "may this person be in this room" had the same answer.
 *
 * A conversation breaks that. `directConversationId` hashes the sorted pair of
 * member ids, and the file it lives in says outright that the result is not a
 * secret: anybody who can read a member list can compute the id of any two
 * people's conversation. So the id being nameable proves nothing, and a call
 * placed in a conversation room is only private if this handler asks who is in
 * it.
 *
 * The second half is the same problem pointed the other way. Even a properly
 * gated call leaks if the server then announces the room id to everybody, so
 * the member list is asserted on here too.
 *
 * There is no SFU in these tests. Past the access check the handler fails on
 * `sfuClient` being null, which is fine — what is under test is which requests
 * get that far.
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
    // Mallory is a member of this server in good standing and holds every
    // permission Alice does. The only thing she is missing is being in the
    // conversation — and she can work its id out from the member list, which is
    // the whole reason this check has to exist.
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
    // The hash is what decides whether a broadcast goes out at all, so a
    // conversation id left in it would be a second copy of the same leak —
    // and would repaint every client each time somebody moved between calls.
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
