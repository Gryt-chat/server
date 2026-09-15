import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";

import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { createPermissionScope, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { openDirectConversation } from "../../db/sqlite/conversations";
import { createServerConfigIfNotExists } from "../../db/sqlite/servers";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { registerDiagnosticsHandlers } from "./diagnostics";
import { registerJoinHandlers } from "./join";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Two guests join through the real handshake, then everything each one was sent
 * is searched for the other's token and identity. GRYT-1239.
 */

const HOST = "record-leaks.test:5001";
const SERVER_ID = "record-leaks-test";

/** Secrets by name. `permissions` is a Set on the record, which JSON turns into `{}`. */
const SECRET_KEYS = new Set(["accessToken", "refreshToken", "fileToken", "grytUserId", "permissions", "latencyStats"]);
const ADDRESS_KEY = /^(ip|ipAddress|address|remoteAddress|forwardedFor)$/i;

interface Delivery {
  event: string;
  payload: unknown;
  via: "socket" | "room";
}

interface Guest {
  id: string;
  received: Delivery[];
  handlers: EventHandlerMap;
  accessToken: string;
}

/** socket.io sends JSON, so this is what arrives rather than the object handed to emit. */
function wire(payload: unknown): unknown {
  return payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
}

const clientsInfo: Clients = {};
const inboxes = new Map<string, { rooms: Set<string>; received: Delivery[]; emit: (e: string, p?: unknown) => boolean }>();

const io = {
  sockets: { sockets: inboxes },
  to(room: string) {
    return {
      emit(event: string, payload?: unknown) {
        for (const s of inboxes.values()) {
          if (s.rooms.has(room)) s.received.push({ event, payload: wire(payload), via: "room" });
        }
      },
    };
  },
  emit(event: string, payload?: unknown) {
    for (const s of inboxes.values()) s.received.push({ event, payload: wire(payload), via: "room" });
  },
};

/** The broadcasts are debounced and fired without awaiting. */
const settle = () => new Promise((r) => setTimeout(r, 400));

function connect(n: number): Omit<Guest, "accessToken"> {
  const id = `sock-${n}`;
  const received: Delivery[] = [];
  const rooms = new Set<string>([id]);
  const socket = {
    id,
    rooms,
    received,
    handshake: { headers: { host: HOST }, address: "127.0.0.1", auth: {} },
    emit(event: string, payload?: unknown) {
      received.push({ event, payload: wire(payload), via: "socket" });
      return true;
    },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) {
      return {
        emit(event: string, payload?: unknown) {
          for (const [sid, s] of inboxes) {
            if (sid !== id && s.rooms.has(room)) s.received.push({ event, payload: wire(payload), via: "room" });
          }
        },
      };
    },
    disconnect() {},
  };
  inboxes.set(id, socket);

  // What `socketHandler` writes for a fresh connection.
  clientsInfo[id] = {
    serverUserId: `temp_${id}`, nickname: "User", color: "#5865f2",
    isMuted: false, isDeafened: false, streamID: "", hasJoinedChannel: false, voiceChannelId: "",
    isConnectedToVoice: false, isAFK: false, cameraEnabled: false, cameraStreamID: "",
    screenShareEnabled: false, screenShareVideoStreamID: "", screenShareAudioStreamID: "",
    isServerMuted: false, isServerDeafened: false,
  };

  const ctx = {
    io, socket, clientId: id, serverId: SERVER_ID, clientsInfo, sfuClient: null,
    getClientIp: () => "127.0.0.1", clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { id, received, handlers: { ...registerJoinHandlers(ctx), ...registerDiagnosticsHandlers(ctx) } };
}

/** A local identity signed the way the client signs one. */
async function joinAsGuest(n: number, nickname: string): Promise<Guest> {
  const guest = connect(n);
  await guest.handlers["server:join"]({ nickname });
  const challenge = guest.received.find((d) => d.event === "server:challenge")?.payload as
    | { nonce: string; serverHost: string }
    | undefined;
  assert.ok(challenge, `${nickname} got no challenge: ${JSON.stringify(guest.received)}`);

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const sub = `key:${await calculateJwkThumbprint(jwk, "sha256")}`;
  const certificate = await new SignJWT({ jwk })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer("gryt:self")
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(privateKey);
  const assertion = await new SignJWT({ nonce: challenge.nonce })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setSubject(sub)
    .setAudience(challenge.serverHost)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);

  await guest.handlers["server:verify"]({ certificate, assertion });
  const joined = guest.received.find((d) => d.event === "server:joined")?.payload as { accessToken?: string } | undefined;
  assert.ok(
    joined?.accessToken,
    `${nickname} did not get in: ${JSON.stringify(guest.received.filter((d) => d.event === "server:error"))}`,
  );
  return { ...guest, accessToken: joined.accessToken };
}

/** Every secret-named key at any depth, as a path. */
function secretPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => secretPaths(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(SECRET_KEYS.has(k) || ADDRESS_KEY.test(k) ? [`${path}.${k}`] : []),
    ...secretPaths(v, `${path}.${k}`),
  ]);
}

/** Your own token and standing reach you by name; nothing else may carry either. */
function secretsIn(received: Delivery[]): string[] {
  return received.flatMap((d, i) => {
    if (d.event === "server:joined" || d.event === "token:refreshed") return [];
    if (d.event === "server:details") {
      const rest = { ...(d.payload as Record<string, unknown>) };
      delete rest.server_info;
      return secretPaths(rest, `#${i} server:details`);
    }
    return secretPaths(d.payload, `#${i} ${d.event}`);
  });
}

function latest(received: Delivery[], event: string): Delivery | undefined {
  return [...received].reverse().find((d) => d.event === event);
}

let dir: string;
let alice: Guest;
let bob: Guest;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-record-leaks-"));
  process.env.DATA_DIR = dir;
  process.env.GRYT_IDENTITY_TIERS = "local";
  await initSqlite();
  await createServerConfigIfNotExists();
  getSqliteDb().prepare(`UPDATE server_config SET join_policy = 'open'`).run();

  alice = await joinAsGuest(1, "Alice");
  bob = await joinAsGuest(2, "Bob");
  await settle();
});

after(() => {
  delete process.env.DATA_DIR;
  delete process.env.GRYT_IDENTITY_TIERS;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file open past the run.
  }
});

describe("what one member is sent about another", () => {
  it("carries nobody else's access token or identity, anywhere", () => {
    for (const [viewer, other] of [[alice, bob], [bob, alice]] as const) {
      const everything = JSON.stringify(viewer.received);
      assert.ok(viewer.received.some((d) => d.event === "server:clients"), `${viewer.id} was never sent server:clients`);
      assert.equal(everything.includes(other.accessToken), false, `${viewer.id} was sent ${other.id}'s access token`);
      const otherIdentity = clientsInfo[other.id].grytUserId!;
      assert.equal(everything.includes(otherIdentity), false, `${viewer.id} was sent ${other.id}'s grytUserId`);
    }
  });

  it("names no secret field in server:clients, server:details.clients or members:list", () => {
    // Bob joined second, so his copy of details holds Alice and Alice's broadcast holds Bob.
    const details = latest(bob.received, "server:details")?.payload as { clients?: Record<string, unknown> };
    assert.ok(details?.clients && Object.keys(details.clients).length === 2, "server:details listed nobody to check");
    assert.deepEqual(secretPaths(details.clients, "server:details.clients"), []);

    const clients = latest(alice.received, "server:clients")?.payload as Record<string, unknown>;
    assert.ok(clients && Object.keys(clients).length === 2, "server:clients listed nobody to check");
    assert.deepEqual(secretPaths(clients, "server:clients"), []);

    assert.ok(latest(alice.received, "members:list"), "members:list was never sent");
    assert.deepEqual(secretsIn(alice.received), []);
    assert.deepEqual(secretsIn(bob.received), []);
  });

  it("still tells each member their own state, token and standing", () => {
    for (const guest of [alice, bob]) {
      const own = (latest(guest.received, "server:clients")?.payload as Record<string, Record<string, unknown>>)[guest.id];
      assert.ok(own, `${guest.id} is missing from its own server:clients`);
      assert.equal(own.serverUserId, clientsInfo[guest.id].serverUserId);
      assert.equal(own.nickname, clientsInfo[guest.id].nickname);
      for (const field of ["isServerMuted", "isServerDeafened", "isMuted", "isDeafened", "hasJoinedChannel", "voiceChannelId"]) {
        assert.ok(field in own, `${guest.id}'s own entry lost ${field}`);
      }

      const info = (latest(guest.received, "server:details")?.payload as { server_info: { permissions: string[]; role: string } }).server_info;
      assert.ok(Array.isArray(info.permissions) && info.permissions.length > 0, `${guest.id} lost its own permissions`);
      assert.equal(typeof info.role, "string");
    }
  });
});

describe("the same, with people in voice", () => {
  it("leaks nothing once somebody is sharing, on camera and in a DM call", async () => {
    const lounge = "lounge";
    Object.assign(clientsInfo[alice.id], {
      hasJoinedChannel: true, isConnectedToVoice: true, voiceChannelId: lounge, streamID: "stream-a",
      cameraEnabled: true, cameraStreamID: "camera-a", screenShareEnabled: true,
      screenShareVideoStreamID: "share-video-a", screenShareAudioStreamID: "share-audio-a",
      activity: "Playing something", latencyStats: { estimatedOneWayMs: 20, networkRttMs: 40, jitterMs: 2, codec: "opus", bitrateKbps: 64 },
    });
    const dm = await openDirectConversation(clientsInfo[alice.id].serverUserId, clientsInfo[bob.id].serverUserId);
    Object.assign(clientsInfo[bob.id], {
      hasJoinedChannel: true, isConnectedToVoice: true, voiceChannelId: dm.conversation_id, streamID: "stream-b",
    });

    const mark = { alice: alice.received.length, bob: bob.received.length };
    await alice.handlers["presence:heartbeat"]();
    await alice.handlers["server:details"]();
    await bob.handlers["server:details"]();
    await settle();

    const aliceNow = alice.received.slice(mark.alice);
    const bobNow = bob.received.slice(mark.bob);
    assert.ok(bobNow.some((d) => d.event === "server:clients"), "the voice change was never broadcast");
    assert.ok(aliceNow.some((d) => d.event === "voice:call:members"), "the DM call was never announced");
    assert.deepEqual(secretsIn(aliceNow), []);
    assert.deepEqual(secretsIn(bobNow), []);
    assert.equal(JSON.stringify(bobNow).includes(alice.accessToken), false, "bob was sent alice's token");
    assert.equal(JSON.stringify(aliceNow).includes(bob.accessToken), false, "alice was sent bob's token");
  });

  it("leaks nothing while a gated channel exists with nobody in it", async () => {
    await upsertServerChannel({ channelId: "backroom", name: "Back room", type: "voice", position: 50 });
    await setChannelPermissionScope("backroom", await createPermissionScope({ name: "Gated", isTemplate: false }));
    resetChannelPermissionCache();
    // Something has to change, or the dedupe sends nothing to check.
    clientsInfo[alice.id].isMuted = true;

    const mark = bob.received.length;
    await alice.handlers["presence:heartbeat"]();
    await settle();

    const bobNow = bob.received.slice(mark);
    assert.ok(bobNow.some((d) => d.event === "server:clients" && d.via === "room"), "server:clients was not sent to the room");
    assert.deepEqual(secretsIn(bobNow), []);
    assert.equal(JSON.stringify(bobNow).includes(alice.accessToken), false, "bob was sent alice's token");
  });

  it("leaks nothing on the per-recipient path a gated channel takes", async () => {
    clientsInfo[alice.id].voiceChannelId = "backroom";

    const mark = bob.received.length;
    await alice.handlers["presence:heartbeat"]();
    await settle();

    const bobNow = bob.received.slice(mark);
    const perSocket = bobNow.filter((d) => d.event === "server:clients" && d.via === "socket");
    assert.ok(perSocket.length > 0, "server:clients did not take the per-recipient branch");
    assert.deepEqual(secretsIn(bobNow), []);
    assert.equal(JSON.stringify(bobNow).includes(alice.accessToken), false, "bob was sent alice's token");
  });
});
