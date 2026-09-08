import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerOwner, setServerRole } from "../../db/sqlite/servers";
import { getUserByServerId, setUserAvatar, upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { registerJoinHelpers } from "./joinHelpers";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * The owner cannot leave, since there is one and the server would be left with
 * nobody to administer it. The row and nickname stay so messages keep a name.
 */

const HOST = "leave.test:5001";

interface Device {
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
}

let dir: string;
const clientsInfo: Clients = {};

function makeDevice(seq: number, grytUserId: string, nickname: string, serverUserId: string): Device {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; },
    disconnect() {},
    join() {}, leave() {}, to: () => ({ emit() {} }),
  };
  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];
  const ctx = {
    io: { sockets: { sockets: new Map() }, to: () => ({ emit() {} }), emit() {} },
    socket, clientId, serverId: "leave-test",
    clientsInfo, sfuClient: null, getClientIp: () => `10.0.0.${seq}`, clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return {
    handlers: registerJoinHelpers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

let ownerUserId: string;
let memberUserId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-leave-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  const owner = await upsertUser("account-owner", "Owner");
  const member = await upsertUser("account-member", "Member");
  ownerUserId = owner.server_user_id;
  memberUserId = member.server_user_id;
  await setServerRole(owner.server_user_id, "owner");
  await setServerRole(member.server_user_id, "member");
  await setServerOwner("account-owner");

  // Both have uploaded a picture, which is the thing a leave is meant to drop.
  await setUserAvatar(ownerUserId, "file-owner");
  await setUserAvatar(memberUserId, "file-member");
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe("the owner leaving", () => {
  it("is refused, and says why", async () => {
    const device = makeDevice(1, "account-owner", "Owner", ownerUserId);
    await device.handlers["server:leave"]();

    const error = device.received("server:error").at(-1) as { error: string; message: string };
    assert.equal(error?.error, "owner_cannot_leave");
    assert.match(error.message, /own this server/i);
  });

  it("leaves the membership alone, so the server still has somebody running it", async () => {
    const user = await getUserByServerId(ownerUserId);
    assert.equal(user?.is_active, true, "a refused leave must not half-apply");
    assert.equal(user?.avatar_file_id, "file-owner", "and must not take the picture either");
  });
});

describe("a member leaving", () => {
  it("ends the membership", async () => {
    const device = makeDevice(2, "account-member", "Member", memberUserId);
    await device.handlers["server:leave"]();

    assert.deepEqual(device.received("server:error"), [], "nothing should have been refused");
    assert.equal(device.received("server:left").length, 1);

    const user = await getUserByServerId(memberUserId);
    assert.equal(user?.is_active, false);
  });

  it("deletes the picture, and keeps the row and the name on it", async () => {
    const user = await getUserByServerId(memberUserId);
    // Falsy rather than null, since the row mapper reports SQL NULL as
    // undefined. Nothing points at the file, so the sweep collects it.
    assert.ok(!user?.avatar_file_id, "the picture must not still be referenced");

    // The row is what the messages they wrote are attributed to. Deleting it
    // would take their name off everything they ever said here.
    assert.ok(user, "the membership row has to survive");
    assert.equal(user?.nickname, "Member");
  });

  it("lets them come back to the same membership", async () => {
    const again = await upsertUser("account-member", "Member");
    assert.equal(again.server_user_id, memberUserId, "rejoining rebinds rather than starting over");
    assert.equal(again.is_active, true);
  });
});
