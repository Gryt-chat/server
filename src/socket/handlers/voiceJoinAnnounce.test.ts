import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { directConversationId, openDirectConversation } from "../../db/sqlite/conversations";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { voiceRoomName } from "../utils/voiceRooms";
import type { EventHandlerMap, HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * Only `voice:channel:joined` sets `hasJoinedChannel`, so broadcasting on
 * `voice:stream:set` alone counted first and left a caller on an empty view.
 */

const HOST = "voicejoin.test:5001";
const SERVER_ID = "voicejoin-test";

let dir: string;

interface RoomEmit {
  room: string;
  event: string;
  payload: unknown;
}

const roomEmits: RoomEmit[] = [];

const io = {
  to(room: string) {
    return {
      emit(event: string, payload?: unknown) {
        roomEmits.push({ room, event, payload });
      },
    };
  },
  emit() {},
  sockets: { sockets: new Map() },
};

interface Member {
  clientId: string;
  serverUserId: string;
  handlers: EventHandlerMap;
}

const clientsInfo: Clients = {};
let seq = 0;

async function connectMember(nickname: string): Promise<Member> {
  seq += 1;
  const clientId = `join-socket-${seq}`;
  const grytUserId = `account-join-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: () => true,
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
    serverId: SERVER_ID,
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.2.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { clientId, serverUserId: user.server_user_id, handlers: registerVoiceHandlers(ctx) };
}

/** The grant is skipped, since `voice:room:request` needs an SFU. Setting the
    field is what it does, and that is the part that matters. */
async function joinRoom(member: Member, roomId: string, streamId: string): Promise<void> {
  clientsInfo[member.clientId].voiceChannelId = roomId;
  member.handlers["voice:stream:set"](streamId);
  await member.handlers["voice:channel:joined"](true);
}

/** Who a `voice:call:members` sent into this room said was in the call. */
function callMembersIn(roomId: string): string[][] {
  const room = voiceRoomName(SERVER_ID, roomId);
  return roomEmits
    .filter((e) => e.room === room && e.event === "voice:call:members")
    .map((e) => (e.payload as { server_user_ids: string[] }).server_user_ids);
}

let alice: Member;
let bob: Member;
let pairId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-voicejoin-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: "general", name: "general", type: "voice" });
  resetChannelIdCache();

  alice = await connectMember("Alice");
  bob = await connectMember("Bob");

  await openDirectConversation(alice.serverUserId, bob.serverUserId);
  pairId = directConversationId(alice.serverUserId, bob.serverUserId);
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  roomEmits.length = 0;
});

describe("joining a call says so", () => {
  it("names the first person in, before anybody answers", async () => {
    await joinRoom(alice, pairId, "stream-alice");

    const announced = callMembersIn(pairId);
    assert.deepEqual(
      announced.at(-1),
      [alice.serverUserId],
      "the caller is alone in the room and has to be drawn in it — this is the empty voice view",
    );
  });

  it("names both once the second answers", async () => {
    await joinRoom(bob, pairId, "stream-bob");

    const announced = callMembersIn(pairId);
    assert.deepEqual(announced.at(-1), [alice.serverUserId, bob.serverUserId].sort());
  });

  it("stops naming somebody who has left", async () => {
    await alice.handlers["voice:channel:joined"](false);

    assert.deepEqual(callMembersIn(pairId).at(-1), [bob.serverUserId]);
  });
});
