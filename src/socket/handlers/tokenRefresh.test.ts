import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { createRefreshToken } from "../../db/sqlite/tokens";
import { updateUserNickname, upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { refreshNeedsBroadcast, registerJoinHelpers } from "./joinHelpers";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Every client refreshes every server on a timer, so a refresh that rebuilds the
 * member list is that work times every member, all day. GRYT-1140.
 */

const HOST = "refresh.test:5001";

interface Device {
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
  /** Rooms joined and room broadcasts sent, which is what a membership change does. */
  joins: () => number;
  broadcasts: () => number;
  disconnected: () => boolean;
}

let dir: string;
const clientsInfo: Clients = {};
let serverUserId: string;

/** The broadcasts are fired without awaiting, so give them a moment to land. */
const settle = () => new Promise((r) => setTimeout(r, 50));

function makeDevice(seq: number, opts: { verified: boolean; nickname: string }): Device {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  const rooms = new Set<string>(opts.verified ? [clientId, "verifiedClients"] : [clientId]);
  let joins = 0;
  let broadcasts = 0;
  let gone = false;
  const socket = {
    id: clientId,
    rooms,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; },
    disconnect() { gone = true; },
    join(room: string) { joins++; rooms.add(room); },
    leave() {},
    to: () => ({ emit() {} }),
  };
  clientsInfo[clientId] = {
    serverUserId, grytUserId: "account-carol", nickname: opts.nickname,
    isServerMuted: false, isServerDeafened: false,
  } as Clients[string];
  const io = {
    sockets: { sockets: new Map() },
    to: () => ({ emit() { broadcasts++; } }),
    emit() {},
  };
  const ctx = {
    io, socket, clientId, serverId: `refresh-test-${seq}`,
    clientsInfo, sfuClient: null, getClientIp: () => `10.0.0.${seq}`, clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return {
    handlers: registerJoinHelpers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    joins: () => joins,
    broadcasts: () => broadcasts,
    disconnected: () => gone,
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-refresh-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  const carol = await upsertUser("account-carol", "Carol");
  serverUserId = carol.server_user_id;
  await setServerRole(serverUserId, "member");
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe("deciding whether a refresh is news", () => {
  const same = { grytUserId: "g", serverUserId: "s", nickname: "Carol", isServerMuted: false, isServerDeafened: false };

  it("is not, for a verified socket whose record did not move", () => {
    assert.equal(refreshNeedsBroadcast(true, same, { ...same }), false);
  });

  it("is, for a socket the refresh is admitting", () => {
    assert.equal(refreshNeedsBroadcast(false, same, { ...same }), true);
  });

  it("is, when the name or the moderation state changed underneath it", () => {
    assert.equal(refreshNeedsBroadcast(true, same, { ...same, nickname: "Caz" }), true);
    assert.equal(refreshNeedsBroadcast(true, same, { ...same, isServerMuted: true }), true);
    assert.equal(refreshNeedsBroadcast(true, same, { ...same, serverUserId: "other" }), true);
  });

  it("is, when there was no record to compare", () => {
    assert.equal(refreshNeedsBroadcast(true, undefined, same), true);
  });
});

describe("token:refresh with a refresh token", () => {
  it("mints tokens and stops there for a member already in", async () => {
    const device = makeDevice(1, { verified: true, nickname: "Carol" });
    const record = await createRefreshToken({ grytUserId: "account-carol", serverUserId });
    await device.handlers["token:refresh"]({ refreshToken: record.token_id });
    await settle();

    const minted = device.received("token:refreshed").at(-1) as { accessToken?: string; fileToken?: string };
    assert.ok(minted?.accessToken, "the refresh still has to answer with an access token");
    assert.ok(minted?.fileToken, "and a file token beside it");
    assert.equal(device.joins(), 0, "a routine rotation re-verified the socket");
    assert.equal(device.broadcasts(), 0, "a routine rotation broadcast to the server");
    assert.equal(device.disconnected(), false);
  });

  it("still admits a socket that arrives with only a refresh token", async () => {
    const device = makeDevice(2, { verified: false, nickname: "Carol" });
    const record = await createRefreshToken({ grytUserId: "account-carol", serverUserId });
    await device.handlers["token:refresh"]({ refreshToken: record.token_id });
    await settle();

    assert.equal(device.joins(), 1, "the socket was never put in verifiedClients");
    assert.ok(device.received("token:refreshed").length > 0);
  });

  it("still tells everyone about a rename it picked up", async () => {
    await updateUserNickname(serverUserId, "Caz");
    const device = makeDevice(3, { verified: true, nickname: "Carol" });
    const record = await createRefreshToken({ grytUserId: "account-carol", serverUserId });
    await device.handlers["token:refresh"]({ refreshToken: record.token_id });
    await settle();

    assert.equal(clientsInfo["socket-3"]?.nickname, "Caz");
    assert.ok(device.broadcasts() > 0, "the new name never reached the other members");
    await updateUserNickname(serverUserId, "Carol");
  });
});

describe("token:refresh with an access token", () => {
  it("mints tokens without a broadcast for a member already in", async () => {
    const device = makeDevice(4, { verified: true, nickname: "Carol" });
    const accessToken = generateAccessToken({
      grytUserId: "account-carol", serverUserId, nickname: "Carol",
      serverHost: HOST, tokenVersion: 0, userTokenVersion: 0,
    });
    await device.handlers["token:refresh"]({ accessToken });
    await settle();

    assert.ok((device.received("token:refreshed").at(-1) as { accessToken?: string })?.accessToken);
    assert.equal(device.joins(), 0);
    assert.equal(device.broadcasts(), 0);
  });
});
