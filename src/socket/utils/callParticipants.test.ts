import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists } from "../../db/sqlite/servers";
import type { Clients } from "../../types";
import { broadcastMemberList } from "./clients";
import { voiceRoomName } from "./voiceRooms";

/**
 * Who hears who is in a call.
 *
 * There are two ways to get this wrong and they pull in opposite directions.
 *
 * Tell everybody, and a one-to-one conversation id — which is a hash of the
 * sorted pair, and computable by anybody holding a member list — announces who
 * is talking to whom. That is what `publicVoiceRoom` stops.
 *
 * Tell nobody, and the people in the call cannot see each other: both clients
 * group participants by `voiceChannelId`, so blanking it everywhere meant a
 * call drew nobody in it, including yourself. That shipped.
 *
 * The answer is the room. Everybody in a call is in that call's socket.io room
 * and nobody else is, so the address *is* the access rule. These cases assert
 * both halves: the room hears it, and the broadcast to everyone does not carry
 * it.
 */

const SERVER_ID = "participants-test";

let dir: string;

interface Sent {
  room: string;
  event: string;
  payload: unknown;
}

function makeIo() {
  const sent: Sent[] = [];
  const broadcasts: { event: string; payload: unknown }[] = [];

  const io = {
    to(room: string) {
      return {
        emit(event: string, payload?: unknown) {
          // The member list and `server:clients` both go out through a room
          // too, so those are recorded separately from a targeted call emit.
          if (room === "verifiedClients") broadcasts.push({ event, payload });
          else sent.push({ room, event, payload });
        },
      };
    },
    emit(event: string, payload?: unknown) {
      broadcasts.push({ event, payload });
    },
    sockets: { sockets: new Map() },
  } as unknown as Parameters<typeof broadcastMemberList>[0];

  return { io, sent, broadcasts };
}

function connected(serverUserId: string, voiceChannelId: string): Clients[string] {
  return {
    serverUserId,
    grytUserId: `account-${serverUserId}`,
    nickname: serverUserId,
    color: "#666666",
    isMuted: false,
    isDeafened: false,
    streamID: "",
    hasJoinedChannel: Boolean(voiceChannelId),
    voiceChannelId,
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
  } as Clients[string];
}

const PAIR = "dm_1111111111111111111111111111aaaa";
const OTHER = "dm_2222222222222222222222222222bbbb";

let world: ReturnType<typeof makeIo>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-participants-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

beforeEach(() => {
  world = makeIo();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function callMembers(sent: Sent[]): Sent[] {
  return sent.filter((s) => s.event === "voice:call:members");
}

describe("who is in a conversation call", () => {
  it("names them into that call's room and nowhere else", () => {
    const clientsInfo: Clients = {
      a: connected("user_alice", PAIR),
      b: connected("user_bob", PAIR),
    };

    broadcastMemberList(world.io, clientsInfo, SERVER_ID);

    const told = callMembers(world.sent);
    assert.equal(told.length, 1);
    assert.equal(told[0].room, voiceRoomName(SERVER_ID, PAIR));
    assert.deepEqual(told[0].payload, {
      conversation_id: PAIR,
      server_user_ids: ["user_alice", "user_bob"],
    });
  });

  it("keeps two calls apart", () => {
    const clientsInfo: Clients = {
      a: connected("user_alice", PAIR),
      b: connected("user_bob", PAIR),
      c: connected("user_cleo", OTHER),
      d: connected("user_dana", OTHER),
    };

    broadcastMemberList(world.io, clientsInfo, SERVER_ID);

    const rooms = callMembers(world.sent).map((s) => s.room).sort();
    assert.deepEqual(rooms, [
      voiceRoomName(SERVER_ID, OTHER),
      voiceRoomName(SERVER_ID, PAIR),
    ].sort());

    const pair = callMembers(world.sent).find((s) => s.room === voiceRoomName(SERVER_ID, PAIR));
    assert.deepEqual(
      (pair!.payload as { server_user_ids: string[] }).server_user_ids,
      ["user_alice", "user_bob"],
      "the other call's members must not appear in this one",
    );
  });

  it("says nothing about a channel", () => {
    // The member list already names those, and a payload on every voice event
    // to repeat it is a cost with nothing behind it.
    const clientsInfo: Clients = { a: connected("user_alice", "general") };
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);
    assert.equal(callMembers(world.sent).length, 0);
  });

  it("leaves the conversation id out of what goes to everybody", () => {
    const clientsInfo: Clients = { a: connected("user_alice", PAIR) };
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);

    // The half `publicVoiceRoom` is responsible for, asserted here as well:
    // this file is where somebody would go to make the call visible, and the
    // easy wrong fix is to unblank it.
    const everyone = JSON.stringify(world.broadcasts);
    assert.equal(
      everyone.includes(PAIR),
      false,
      "a conversation id reached a broadcast that goes to the whole server",
    );
  });

  it("does not count somebody who has not finished joining", () => {
    const halfway = connected("user_bob", PAIR);
    halfway.hasJoinedChannel = false;

    const clientsInfo: Clients = { a: connected("user_alice", PAIR), b: halfway };
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);

    assert.deepEqual(
      (callMembers(world.sent)[0].payload as { server_user_ids: string[] }).server_user_ids,
      ["user_alice"],
    );
  });

  it("says it again only when the people change", () => {
    const clientsInfo: Clients = { a: connected("user_alice", PAIR) };

    broadcastMemberList(world.io, clientsInfo, SERVER_ID);
    assert.equal(callMembers(world.sent).length, 1);

    // A mute, a camera, anything else that repaints the member list.
    clientsInfo.a.isMuted = true;
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);
    assert.equal(callMembers(world.sent).length, 1, "nothing changed about who is in the call");

    clientsInfo.b = connected("user_bob", PAIR);
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);
    assert.equal(callMembers(world.sent).length, 2);
  });

  it("tells a call again after everybody has left it and come back", () => {
    const clientsInfo: Clients = { a: connected("user_alice", PAIR) };
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);

    delete clientsInfo.a;
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);

    // The same person, the same conversation. Remembering the last list past
    // the end of the call would swallow this one — and it is the first message
    // of the new call, so swallowing it means an empty view again.
    clientsInfo.a = connected("user_alice", PAIR);
    broadcastMemberList(world.io, clientsInfo, SERVER_ID);

    assert.equal(callMembers(world.sent).length, 2);
  });
});
