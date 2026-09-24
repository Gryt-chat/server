import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { sfuRoomId, voiceRoomName } from "../utils/voiceRooms";
import { registerAdminHandlers } from "./admin";
import { registerJoinHandlers } from "./join";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * A socket whose identity is forgotten mid-call has to leave the call: the SFU,
 * the room and the socket's own record. GRYT-1378.
 */

const HOST = "forget-voice.test:5001";
const SERVER_ID = "forget-voice-test";
const CHANNEL = "lounge";
const ROOM = voiceRoomName(SERVER_ID, CHANNEL);

interface Delivery { event: string; payload: unknown }
interface Inbox { rooms: Set<string>; received: Delivery[] }

const clientsInfo: Clients = {};
const inboxes = new Map<string, Inbox & Record<string, unknown>>();
const sfuDisconnects: { roomId: string; userId: string }[] = [];
const sfuUntracked: string[] = [];

const sfuClient = {
  async disconnectUser(roomId: string, userId: string) { sfuDisconnects.push({ roomId, userId }); },
  untrackUserConnection(userId: string) { sfuUntracked.push(userId); },
  trackUserConnection() {},
  isConnected: () => false,
  getActiveUsers: () => new Map(),
};

const io = {
  sockets: { sockets: inboxes },
  to(room: string) {
    return {
      emit(event: string, payload?: unknown) {
        for (const s of inboxes.values()) if (s.rooms.has(room)) s.received.push({ event, payload });
      },
    };
  },
  emit(event: string, payload?: unknown) {
    for (const s of inboxes.values()) s.received.push({ event, payload });
  },
};

let seq = 0;

function connect(): { id: string; received: Delivery[]; rooms: Set<string>; handlers: EventHandlerMap; ctx: HandlerContext } {
  seq += 1;
  const id = `sock-${seq}`;
  const received: Delivery[] = [];
  const rooms = new Set<string>([id]);
  const socket = {
    id, rooms, received,
    handshake: { headers: { host: HOST }, address: "127.0.0.1", auth: {} },
    emit(event: string, payload?: unknown) { received.push({ event, payload }); return true; },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) {
      return {
        emit(event: string, payload?: unknown) {
          for (const [sid, s] of inboxes) if (sid !== id && s.rooms.has(room)) s.received.push({ event, payload });
        },
      };
    },
    disconnect() {},
  };
  inboxes.set(id, socket);
  clientsInfo[id] = {
    serverUserId: `temp_${id}`, nickname: "User", color: "#5865f2",
    isMuted: false, isDeafened: false, streamID: "", hasJoinedChannel: false, voiceChannelId: "",
    isConnectedToVoice: false, isAFK: false, cameraEnabled: false, cameraStreamID: "",
    screenShareEnabled: false, screenShareVideoStreamID: "", screenShareAudioStreamID: "",
    isServerMuted: false, isServerDeafened: false,
  };
  const ctx = {
    io, socket, clientId: id, serverId: SERVER_ID, clientsInfo, sfuClient,
    getClientIp: () => "127.0.0.1", clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return { id, received, rooms, ctx, handlers: { ...registerJoinHandlers(ctx), ...registerAdminHandlers(ctx) } };
}

/** What `voice:join` leaves behind once the media connection is up. */
function putInCall(sid: string): void {
  Object.assign(clientsInfo[sid], {
    hasJoinedChannel: true, voiceChannelId: CHANNEL, streamID: `stream-${sid}`, isConnectedToVoice: true,
  });
  inboxes.get(sid)!.rooms.add(ROOM);
}

function assertLeftCall(sid: string, userIdAtTheSfu: string, bystander: Inbox): void {
  assert.deepEqual(
    sfuDisconnects.filter((d) => d.userId === userIdAtTheSfu),
    [{ roomId: sfuRoomId(SERVER_ID, CHANNEL), userId: userIdAtTheSfu }],
    "the SFU was never told to drop them",
  );
  assert.ok(sfuUntracked.includes(userIdAtTheSfu), "the SFU connection is still tracked");
  assert.ok(
    bystander.received.some(
      (d) => d.event === "voice:peer:left" && (d.payload as { clientId?: string }).clientId === sid,
    ),
    "the rest of the call was not told they left",
  );
  const ci = clientsInfo[sid];
  assert.equal(ci.hasJoinedChannel, false);
  assert.equal(ci.voiceChannelId, "");
  assert.equal(ci.streamID, "");
  assert.equal(ci.isConnectedToVoice, false);
  assert.equal(inboxes.get(sid)!.rooms.has(ROOM), false, "still in the voice room");
  assert.ok(inboxes.get(sid)!.received.some((d) => d.event === "voice:room:leave"), "its own client was not told");
}

let dir: string;
let ca: { server: HttpServer; issuer: string; privateKey: CryptoKey };

async function signAs(key: CryptoKey, claims: Record<string, unknown>, build: (j: SignJWT) => SignJWT, kid?: string) {
  const header = { alg: "ES256", typ: "JWT", ...(kid ? { kid } : {}) };
  return build(new SignJWT(claims).setProtectedHeader(header).setIssuedAt()).sign(key);
}

async function challengeFor(handlers: EventHandlerMap, received: Delivery[], nickname: string) {
  await handlers["server:join"]({ nickname });
  const challenge = received.find((d) => d.event === "server:challenge")?.payload as { nonce: string } | undefined;
  assert.ok(challenge, `no challenge: ${JSON.stringify(received)}`);
  return challenge.nonce;
}

function assertJoined(received: Delivery[]): void {
  assert.ok(
    received.some((d) => d.event === "server:joined"),
    JSON.stringify(received.filter((d) => d.event === "server:error")),
  );
}

async function joinAsGuest(c = connect()): Promise<{ id: string; key: CryptoKey; jwk: JWK }> {
  c.received.length = 0;
  const nonce = await challengeFor(c.handlers, c.received, "Guest");
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const sub = `key:${await calculateJwkThumbprint(jwk, "sha256")}`;
  const certificate = await signAs(privateKey, { jwk }, (j) => j.setIssuer("gryt:self").setSubject(sub).setExpirationTime("24h"));
  const assertion = await signAs(privateKey, { nonce }, (j) => j.setSubject(sub).setAudience(HOST).setExpirationTime("60s"));
  await c.handlers["server:verify"]({ certificate, assertion });
  assertJoined(c.received);
  return { id: c.id, key: privateKey, jwk };
}

/** An account certificate from the test CA, and optionally a proof of the guest key. */
async function joinAsAccount(sub: string, guest?: { key: CryptoKey; jwk: JWK }) {
  const c = connect();
  const nonce = await challengeFor(c.handlers, c.received, "Account");
  const device = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(device.publicKey);
  const certificate = await signAs(ca.privateKey, { jwk, preferred_username: "account" }, (j) =>
    j.setIssuer(ca.issuer).setSubject(sub).setExpirationTime("1h"), "ca");
  const assertion = await signAs(device.privateKey, { nonce }, (j) => j.setSubject(sub).setAudience(HOST).setExpirationTime("60s"));
  const link = guest
    ? await signAs(guest.key, { jwk: guest.jwk, nonce, link_to: sub }, (j) =>
        j.setIssuer("gryt:link").setAudience(HOST).setExpirationTime("60s"))
    : undefined;
  await c.handlers["server:verify"]({ certificate, assertion, link });
  assertJoined(c.received);
  return c;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-forget-voice-"));
  process.env.DATA_DIR = dir;
  process.env.GRYT_IDENTITY_TIERS = "local,account";

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "ca", alg: "ES256", use: "sig" }] });
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(jwks); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.GRYT_TRUSTED_CERT_ISSUERS = issuer;
  ca = { server, issuer, privateKey };

  await initSqlite();
  await createServerConfigIfNotExists();
  getSqliteDb().prepare(`UPDATE server_config SET join_policy = 'open'`).run();
  await createRoleDefinition("replacer", { name: "Replacer", rank: 90, permissions: ["replace_identity", "view_members"] });
});

after(() => {
  ca?.server.close();
  delete process.env.DATA_DIR;
  delete process.env.GRYT_IDENTITY_TIERS;
  delete process.env.GRYT_TRUSTED_CERT_ISSUERS;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe("a socket that loses its identity mid-call", () => {
  it("leaves the call when its guest membership is merged into an account", async () => {
    const accountSub = "0c8f2e1a-4b6d-4f2a-9c3e-71b0a5d9e4f7";
    await joinAsAccount(accountSub);

    const guest = await joinAsGuest();
    const guestServerUserId = clientsInfo[guest.id].serverUserId;
    putInCall(guest.id);
    const bystander = connect();
    putInCall(bystander.id);

    const merging = await joinAsAccount(accountSub, guest);

    assert.ok(clientsInfo[guest.id].serverUserId.startsWith("temp_"), "the merge never reached the guest socket");
    assert.ok(merging.received.some((d) => d.event === "server:joined"));
    assertLeftCall(guest.id, guestServerUserId, inboxes.get(bystander.id)!);
  });

  it("leaves the call when the same socket proves a different identity", async () => {
    const c = connect();
    await joinAsGuest(c);
    const firstServerUserId = clientsInfo[c.id].serverUserId;
    putInCall(c.id);
    const bystander = connect();
    putInCall(bystander.id);

    await joinAsGuest(c);

    assert.notEqual(clientsInfo[c.id].serverUserId, firstServerUserId, "the socket never became somebody else");
    assertLeftCall(c.id, firstServerUserId, inboxes.get(bystander.id)!);
  });

  it("leaves the call when an admin replaces the identity behind it", async () => {
    const admin = connect();
    const adminUser = await upsertUser(`account-admin-${seq}`, "Admin");
    await setServerRole(adminUser.server_user_id, "replacer");
    Object.assign(clientsInfo[admin.id], { serverUserId: adminUser.server_user_id, grytUserId: `account-admin-${seq}` });

    const member = connect();
    const memberUser = await upsertUser(`key:member-${seq}`, "Member");
    await setServerRole(memberUser.server_user_id, "member");
    Object.assign(clientsInfo[member.id], { serverUserId: memberUser.server_user_id, grytUserId: `key:member-${seq}` });
    putInCall(member.id);
    const bystander = connect();
    putInCall(bystander.id);

    await admin.handlers["server:user:replace"]({
      accessToken: generateAccessToken({
        grytUserId: `account-admin-${seq}`, serverUserId: adminUser.server_user_id,
        nickname: "Admin", serverHost: HOST, tokenVersion: 0,
      }),
      targetServerUserId: memberUser.server_user_id,
      newGrytUserId: `account-new-${seq}`,
    });

    assert.ok(admin.received.some((d) => d.event === "server:user:replace:success"), JSON.stringify(admin.received));
    assertLeftCall(member.id, memberUser.server_user_id, inboxes.get(bystander.id)!);
  });
});
