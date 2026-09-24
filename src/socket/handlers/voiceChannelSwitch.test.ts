import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { voiceRoomName } from "../utils/voiceRooms";
import type { EventHandlerMap, HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * Switching channels never moves `hasJoinedChannel`, so the announcement used
 * to return early and leave the socket in the old channel's room. GRYT-1326.
 */

const HOST = "voiceswitch.test:5001";
const SERVER_ID = "voiceswitch-test";

let dir: string;

interface Delivery {
  room: string;
  event: string;
  payload: unknown;
}

interface Member {
  clientId: string;
  serverUserId: string;
  rooms: Set<string>;
  handlers: EventHandlerMap;
}

/** What each socket was sent through a room it is in. */
const delivered: Delivery[] = [];
const sockets = new Map<string, { rooms: Set<string> }>();

const io = {
  to(room: string) {
    return {
      emit(event: string, payload?: unknown) {
        for (const s of sockets.values()) {
          if (s.rooms.has(room)) delivered.push({ room, event, payload });
        }
      },
    };
  },
  emit() {},
  sockets: { sockets: new Map() },
};

const clientsInfo: Clients = {};
let seq = 0;

async function connectMember(nickname: string): Promise<Member> {
  seq += 1;
  const clientId = `switch-socket-${seq}`;
  const grytUserId = `account-switch-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");

  const rooms = new Set<string>([clientId]);
  const socket = {
    id: clientId,
    rooms,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: () => true,
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) {
      return {
        emit(event: string, payload?: unknown) {
          for (const [sid, s] of sockets) {
            if (sid !== clientId && s.rooms.has(room)) delivered.push({ room, event, payload });
          }
        },
      };
    },
  };
  sockets.set(clientId, socket);

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
    getClientIp: () => `10.3.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { clientId, serverUserId: user.server_user_id, rooms, handlers: registerVoiceHandlers(ctx) };
}

/** The grant is skipped, since `voice:room:request` needs an SFU. Setting the
    field is the part of it this depends on. */
async function joinChannel(member: Member, channelId: string, streamId: string): Promise<void> {
  clientsInfo[member.clientId].voiceChannelId = channelId;
  member.handlers["voice:stream:set"](streamId);
  await member.handlers["voice:channel:joined"](true);
}

/** Voice rooms a socket is in, the channel names only. */
function voiceRoomsOf(member: Member): string[] {
  const prefix = voiceRoomName(SERVER_ID, "");
  return [...member.rooms].filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length)).sort();
}

function peerEventsIn(channelId: string): string[] {
  const room = voiceRoomName(SERVER_ID, channelId);
  return delivered
    .filter((d) => d.room === room && (d.event === "voice:peer:joined" || d.event === "voice:peer:left"))
    .map((d) => `${d.event}:${(d.payload as { nickname: string }).nickname}`);
}

let mover: Member;
let watcherA: Member;
let watcherB: Member;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-voiceswitch-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: "alpha", name: "alpha", type: "voice" });
  await upsertServerChannel({ channelId: "beta", name: "beta", type: "voice" });
  resetChannelIdCache();

  mover = await connectMember("Mover");
  watcherA = await connectMember("WatcherA");
  watcherB = await connectMember("WatcherB");
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delivered.length = 0;
});

describe("switching voice channels", () => {
  it("puts everybody in the room of the channel they joined", async () => {
    await joinChannel(watcherA, "alpha", "stream-watcher-a");
    await joinChannel(watcherB, "beta", "stream-watcher-b");
    await joinChannel(mover, "alpha", "stream-mover");

    assert.deepEqual(voiceRoomsOf(mover), ["alpha"]);
  });

  it("leaves the old channel's room and joins the new one", async () => {
    await joinChannel(mover, "beta", "stream-mover-2");

    assert.deepEqual(voiceRoomsOf(mover), ["beta"], "a socket in both rooms hears both channels");
    assert.deepEqual(peerEventsIn("alpha"), ["voice:peer:left:Mover"]);
    assert.deepEqual(peerEventsIn("beta"), ["voice:peer:joined:Mover"]);
  });

  it("still ignores a re-announced join for the channel it is already in", async () => {
    await mover.handlers["voice:channel:joined"](true);

    assert.deepEqual(voiceRoomsOf(mover), ["beta"]);
    assert.deepEqual(peerEventsIn("beta"), [], "a re-announce is not a second arrival");
  });

  it("leaves the room for good when the call ends", async () => {
    await mover.handlers["voice:channel:joined"](false);

    assert.deepEqual(voiceRoomsOf(mover), []);
    assert.deepEqual(peerEventsIn("beta"), ["voice:peer:left:Mover"]);
  });
});
