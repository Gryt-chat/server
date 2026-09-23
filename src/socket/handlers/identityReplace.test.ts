import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { socketMay } from "../utils/standing";
import { registerAdminHandlers } from "./admin";
import type { HandlerContext } from "./types";

/**
 * Replacing an identity moves the membership away from the key a live socket
 * proved it holds. That socket has to stop counting as the member. GRYT-1250.
 */

const HOST = "replace.test:5001";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-replace-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await createRoleDefinition("replacer", {
    name: "Replacer",
    rank: 90,
    permissions: ["replace_identity", "view_members"],
  });
  await createRoleDefinition("plain", {
    name: "Plain",
    rank: 10,
    permissions: ["view_members", "send_messages"],
  });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

interface Emitted {
  event: string;
  payload: { error?: string; reason?: string };
}

function fakeSocket(id: string, emitted: Emitted[], rooms: Set<string>) {
  return {
    id,
    rooms,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: Emitted["payload"]) {
      emitted.push({ event, payload: payload ?? {} });
      return true;
    },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to: () => ({ emit() {} }),
  };
}

let seq = 0;

/** An admin who may replace, and a member who is connected while it happens. */
async function scene() {
  seq += 1;
  const adminEmitted: Emitted[] = [];
  const memberEmitted: Emitted[] = [];
  const adminId = `admin-${seq}`;
  const memberId = `member-${seq}`;

  const adminRooms = new Set([adminId, "verifiedClients"]);
  const memberRooms = new Set([memberId, "verifiedClients"]);
  const adminSocket = fakeSocket(adminId, adminEmitted, adminRooms);
  const memberSocket = fakeSocket(memberId, memberEmitted, memberRooms);

  const admin = await upsertUser(`account-admin-${seq}`, `Admin ${seq}`);
  await setServerRole(admin.server_user_id, "replacer");
  const member = await upsertUser(`key:member-${seq}`, `Member ${seq}`);
  await setServerRole(member.server_user_id, "plain");

  const clientsInfo: Clients = {};
  clientsInfo[adminId] = {
    serverUserId: admin.server_user_id,
    grytUserId: `account-admin-${seq}`,
    nickname: `Admin ${seq}`,
  } as Clients[string];
  clientsInfo[memberId] = {
    serverUserId: member.server_user_id,
    grytUserId: `key:member-${seq}`,
    nickname: `Member ${seq}`,
    accessToken: "held-by-the-old-key",
    permissions: new Set(["send_messages"]),
  } as unknown as Clients[string];

  const ctx = {
    io: {
      to: () => ({ emit: () => {} }),
      emit: () => {},
      sockets: { sockets: new Map([[adminId, adminSocket], [memberId, memberSocket]]) },
    },
    socket: adminSocket,
    clientId: adminId,
    serverId: "replace-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.0.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  const accessToken = generateAccessToken({
    grytUserId: `account-admin-${seq}`,
    serverUserId: admin.server_user_id,
    nickname: `Admin ${seq}`,
    serverHost: HOST,
    tokenVersion: 0,
  });

  return {
    ctx, clientsInfo, accessToken, adminEmitted, memberEmitted, memberId, memberRooms,
    targetServerUserId: member.server_user_id,
  };
}

describe("replacing an identity cuts off the sockets that held the old one", () => {
  it("leaves the old socket with nothing", async () => {
    const s = await scene();

    assert.equal(
      await socketMay(s.clientsInfo, s.memberId, "send_messages"),
      true,
      "the member could not send in the first place",
    );

    await registerAdminHandlers(s.ctx)["server:user:replace"]({
      accessToken: s.accessToken,
      targetServerUserId: s.targetServerUserId,
      newGrytUserId: `account-new-${seq}`,
    });

    assert.equal(
      s.adminEmitted.some((e) => e.event === "server:user:replace:success"),
      true,
      s.adminEmitted.map((e) => `${e.event} ${JSON.stringify(e.payload)}`).join(" | "),
    );

    const info = s.clientsInfo[s.memberId];
    assert.ok(info.serverUserId.startsWith("temp_"), "still holds the membership");
    assert.equal(info.grytUserId, undefined);
    assert.equal(info.accessToken, undefined);
    assert.equal(info.permissions, undefined);
    assert.equal(s.memberRooms.has("verifiedClients"), false, "still gets member broadcasts");
    assert.equal(
      await socketMay(s.clientsInfo, s.memberId, "send_messages"),
      false,
      "the old key can still act as the member",
    );
  });

  it("tells the old socket why, with the event it already handles", async () => {
    const s = await scene();

    await registerAdminHandlers(s.ctx)["server:user:replace"]({
      accessToken: s.accessToken,
      targetServerUserId: s.targetServerUserId,
      newGrytUserId: `account-new-${seq}`,
    });

    const revoked = s.memberEmitted.filter((e) => e.event === "token:revoked");
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].payload.reason, "identity_replaced");
  });

  it("leaves everybody else's socket alone", async () => {
    const s = await scene();
    const adminBefore = { ...s.clientsInfo[s.ctx.clientId] };

    await registerAdminHandlers(s.ctx)["server:user:replace"]({
      accessToken: s.accessToken,
      targetServerUserId: s.targetServerUserId,
      newGrytUserId: `account-new-${seq}`,
    });

    const admin = s.clientsInfo[s.ctx.clientId];
    assert.equal(admin.serverUserId, adminBefore.serverUserId);
    assert.equal(admin.grytUserId, adminBefore.grytUserId);
    assert.equal(
      s.adminEmitted.some((e) => e.event === "token:revoked"),
      false,
      "the admin was signed out of their own server",
    );
  });
});
