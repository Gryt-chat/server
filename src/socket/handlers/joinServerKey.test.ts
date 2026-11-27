import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";

import { getServerKeyId } from "../../auth/serverIdentity";
import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists } from "../../db/sqlite/servers";
import type { Clients } from "../../types";
import { registerJoinHandlers } from "./join";
import type { HandlerContext } from "./types";

/** A join answered for a challenge that named some other server's host and key
    is refused, and one bound to this server's key gets in. GRYT-2359. */

const clientsInfo: Clients = {};
const room = { emit() {} };
const io = { sockets: { sockets: new Map() }, to: () => room, emit() {} };
let n = 0;

interface Payload { nonce: string; serverHost: string; serverKey: string; reason?: string }

function connect(host: string) {
  const id = `sock-${++n}`;
  const received: { event: string; payload: Payload }[] = [];
  const socket = {
    id,
    rooms: new Set([id]),
    handshake: { headers: { host }, address: "127.0.0.1", auth: {} },
    emit: (event: string, payload?: object) => received.push({ event, payload: JSON.parse(JSON.stringify(payload ?? null)) }),
    join() {}, leave() {}, to: () => room, disconnect() {},
  };
  clientsInfo[id] = { serverUserId: `temp_${id}`, nickname: "User" } as Clients[string];
  const ctx: HandlerContext = {
    io, socket, clientId: id, serverId: "server-key-test", clientsInfo, sfuClient: null,
    getClientIp: () => "127.0.0.1", clientAddressIsOwn: () => true,
  } as never;
  return { received, handlers: registerJoinHandlers(ctx) };
}

/** Joins with a fresh guest identity; `bindTo` picks the `server_key` the client signs. */
async function joinAs(host: string, bindTo: (challengeKey: string) => string | undefined) {
  const s = connect(host);
  await s.handlers["server:join"]({ nickname: "Guest" });
  const challenge = s.received.find((d) => d.event === "server:challenge")?.payload;
  assert.ok(challenge, JSON.stringify(s.received));

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const sub = `key:${await calculateJwkThumbprint(jwk, "sha256")}`;
  const certificate = await new SignJWT({ jwk })
    .setProtectedHeader({ alg: "ES256" }).setIssuer("gryt:self").setSubject(sub)
    .setIssuedAt().setExpirationTime("24h").sign(privateKey);
  const assertion = await new SignJWT({ nonce: challenge.nonce, server_key: bindTo(challenge.serverKey) })
    .setProtectedHeader({ alg: "ES256" }).setSubject(sub).setAudience(challenge.serverHost)
    .setIssuedAt().setExpirationTime("60s").sign(privateKey);

  await s.handlers["server:verify"]({ certificate, assertion });
  return { challenge, reply: s.received.find((d) => d.event === "server:joined" || d.event === "server:error")! };
}

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-server-key-"));
  process.env.DATA_DIR = dir;
  process.env.GRYT_IDENTITY_TIERS = "local";
  await initSqlite();
  await createServerConfigIfNotExists();
  getSqliteDb().prepare(`UPDATE server_config SET join_policy = 'open'`).run();
});

after(() => {
  delete process.env.DATA_DIR;
  delete process.env.GRYT_IDENTITY_TIERS;
  rmSync(dir, { recursive: true, force: true });
});

describe("a join is bound to this server's key", () => {
  it("names our key in the challenge", async () => {
    const s = connect("chat.test:5001");
    await s.handlers["server:join"]({ nickname: "Guest" });
    assert.equal(s.received[0].payload.serverKey, await getServerKeyId());
  });

  it("refuses an assertion a client signed for the server it was joining elsewhere", async () => {
    const { reply } = await joinAs("elsewhere.test:5001", () => "key-of-the-server-the-client-dialled");
    assert.equal(reply.event, "server:error");
    assert.equal(reply.payload.reason, "server_key_mismatch");
  });

  it("admits one bound to our key", async () => {
    const { reply } = await joinAs("chat.test:5001", (key) => key);
    assert.equal(reply.event, "server:joined", JSON.stringify(reply.payload));
  });

  it("still admits an older client that signs no key", async () => {
    const { reply } = await joinAs("chat.test:5001", () => undefined);
    assert.equal(reply.event, "server:joined", JSON.stringify(reply.payload));
  });
});
