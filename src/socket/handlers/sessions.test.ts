import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerSessionHandlers } from "./sessions";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Signing out of the other devices, and staying signed in on this one.
 *
 * The bump invalidates every token the member holds, this socket's included,
 * so the thing most worth pinning here is that the device doing the asking
 * survives it — that is the half that is easy to get backwards.
 */

const HOST = "sessions.test:5001";

interface Device {
  clientId: string;
  accessToken: string;
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
  disconnected: () => boolean;
}

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean; disconnect: (c?: boolean) => void }>();
const clientsInfo: Clients = {};

function makeDevice(seq: number, grytUserId: string, nickname: string, serverUserId: string): Device {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  let gone = false;
  const record = {
    emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; },
    disconnect() { gone = true; },
  };
  sockets.set(clientId, record);
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: record.emit,
    disconnect: record.disconnect,
    join() {}, leave() {}, to: () => ({ emit() {} }),
  };
  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];
  const ctx = {
    io: { sockets: { sockets } }, socket, clientId, serverId: "sessions-test",
    clientsInfo, sfuClient: null, getClientIp: () => `10.0.0.${seq}`, clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return {
    clientId,
    accessToken: generateAccessToken({ grytUserId, serverUserId, nickname, serverHost: HOST, tokenVersion: 0, userTokenVersion: 0 }),
    handlers: registerSessionHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    disconnected: () => gone,
  };
}

let phone: Device;
let laptop: Device;
let bystander: Device;
let aliceServerUserId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-sessions-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  const alice = await upsertUser("account-alice", "Alice");
  const bob = await upsertUser("account-bob", "Bob");
  aliceServerUserId = alice.server_user_id;
  await setServerRole(alice.server_user_id, "member");
  await setServerRole(bob.server_user_id, "member");

  // Two devices for one member, and somebody else entirely.
  phone = makeDevice(1, "account-alice", "Alice", alice.server_user_id);
  laptop = makeDevice(2, "account-alice", "Alice", alice.server_user_id);
  bystander = makeDevice(3, "account-bob", "Bob", bob.server_user_id);
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe("signing out of other devices", () => {
  it("moves the member's counter, so the tokens already out there stop matching", async () => {
    const before = (await getUserByServerId(aliceServerUserId))?.token_version;
    await phone.handlers["session:revoke_others"]({ accessToken: phone.accessToken });
    const after = (await getUserByServerId(aliceServerUserId))?.token_version;
    assert.equal(after, (before ?? 0) + 1);
  });

  it("drops the other device and tells it why", async () => {
    assert.equal(laptop.disconnected(), true, "the laptop should have been disconnected");
    const revoked = laptop.received("token:revoked").at(-1) as { reason: string };
    assert.equal(revoked?.reason, "signed_out_elsewhere");
  });

  it("keeps the device that asked, with a token that still works", async () => {
    assert.equal(phone.disconnected(), false, "the device doing the asking must not sign itself out");

    const minted = phone.received("token:refreshed").at(-1) as { accessToken?: string; refreshToken?: string };
    assert.ok(minted?.accessToken, "it needs a replacement access token, since the bump invalidated its old one");
    assert.ok(minted?.refreshToken, "and a replacement refresh token, since its old one was revoked with the rest");

    // The replacement has to carry the counter's new value, or the very next
    // request from this device is refused by the gates.
    const user = await getUserByServerId(aliceServerUserId);
    const payload = JSON.parse(
      Buffer.from((minted!.accessToken as string).split(".")[1], "base64").toString("utf8"),
    ) as { userTokenVersion?: number };
    assert.equal(payload.userTokenVersion, user?.token_version);
  });

  it("reports how many devices it signed out", async () => {
    const done = phone.received("session:revoked_others").at(-1) as { sessions: number };
    assert.equal(done?.sessions, 1);
  });

  it("leaves other members alone", async () => {
    assert.equal(bystander.disconnected(), false, "signing out your own devices must not touch anybody else's");
    assert.equal(bystander.received("token:revoked").length, 0);
  });
});
