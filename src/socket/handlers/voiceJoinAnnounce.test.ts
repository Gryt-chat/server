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
 * Whether joining a call tells anybody.
 *
 * The client announces a join as two events in a fixed order, ten milliseconds
 * apart: `voice:stream:set` and then `voice:channel:joined`. That order is not
 * incidental — it is what `sfuConnectFlow` does, and only the second one sets
 * `hasJoinedChannel`.
 *
 * `broadcastCallParticipants` counts a person as being in a call when
 * `hasJoinedChannel` is true and their room is a conversation. So when the
 * first of the two events was the only one that broadcast, the count it ran was
 * always the one taken before the flag was set. For the first person into a
 * call that count is zero, nothing is sent, and the second event set the flag
 * without telling anyone.
 *
 * What that looked like: press Call, and the voice view is empty. Your own tile
 * is there while the connection is opening and goes when it completes, because
 * `visibleClients` falls back to matching `voiceChannelId` and the server never
 * said yours. It fills the moment somebody answers — their `voice:stream:set`
 * runs the count again, and by then your flag is set, so the first broadcast of
 * the call finally names you (GRYT-713).
 *
 * A conversation is the case that breaks, and only a conversation: `server:clients`
 * carries `voiceChannelId` for a channel, so a channel draws itself from that
 * whether or not this broadcast happens. Both are asserted anyway — the channel
 * case is what says the member list is no longer a step behind either.
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

/**
 * The two events a client sends on connecting, in the order it sends them.
 *
 * The grant is skipped: `voice:room:request` needs an SFU and these tests have
 * none. Setting the field is what the grant does, and what it does is the part
 * that matters here.
 */
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
