import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { OWNER_ROLE_ID } from "../../constants/permissions";
import { initSqlite } from "../../db/sqlite/connection";
import {
  createRoleDefinition,
  getRoleDefinition,
} from "../../db/sqlite/roleDefinitions";

import {
  createServerConfigIfNotExists,
  setServerOwner,
  setServerRole,
} from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { generateAccessToken } from "../../utils/jwt";
import type { Clients } from "../../types";
import { registerAdminHandlers } from "./admin";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Colour is the one field on the owner role that saves. Most of this file is
 * about the hole being no wider: a payload slipping a rank in beside it is
 * refused outright rather than half-applied.
 */

const HOST = "owner-colour.test:5001";

let dir: string;

/** The owner role as the schema seeds it, read once so the assertions below
 *  compare against what this server actually shipped rather than a guess. */
let seeded: { name: string; rank: number; permissions: string[] };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-owner-colour-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  // Seeded by the schema, not created here — creating it throws, and a test
  // that invented its own owner row would not be testing the real one.
  const owner = await getRoleDefinition(OWNER_ROLE_ID);
  assert.ok(owner, "the owner role should be seeded");
  seeded = { name: owner.name, rank: owner.rank, permissions: owner.permissions };
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

interface Emitted {
  event: string;
  payload: unknown;
}

function makeContext(): { ctx: HandlerContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const clientId = "socket-under-test";

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
  };

  const io = {
    to() {
      return { emit() {} };
    },
    emit() {},
    sockets: { sockets: new Map() },
  };

  const ctx = {
    io,
    socket,
    clientId,
    serverId: "owner-colour-test",
    clientsInfo: {} as Clients,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { ctx, emitted };
}

function handlers(ctx: HandlerContext): EventHandlerMap {
  return registerAdminHandlers(ctx);
}

function refused(emitted: Emitted[]): boolean {
  return emitted.some(
    (e) => (e.payload as { error?: string })?.error === "forbidden",
  );
}

/** The owner, who outranks the owner role by holding it. */
let ownerToken: string;
/** Somebody with `manage_roles` and a rank well below it. */
let adminToken: string;

before(async () => {
  const owner = await upsertUser("account-owner", "Owner");
  await setServerRole(owner.server_user_id, OWNER_ROLE_ID);
  await setServerOwner("account-owner");
  ownerToken = generateAccessToken({
    grytUserId: "account-owner",
    serverUserId: owner.server_user_id,
    nickname: "Owner",
    serverHost: HOST,
    tokenVersion: 0,
  });

  await createRoleDefinition("delegated-admin", {
    name: "Delegated",
    rank: 50,
    permissions: ["manage_roles"],
  });
  const admin = await upsertUser("account-admin", "Admin");
  await setServerRole(admin.server_user_id, "delegated-admin");
  adminToken = generateAccessToken({
    grytUserId: "account-admin",
    serverUserId: admin.server_user_id,
    nickname: "Admin",
    serverHost: HOST,
    tokenVersion: 0,
  });
});

async function save(accessToken: string, payload: Record<string, unknown>) {
  const { ctx, emitted } = makeContext();
  await handlers(ctx)["server:roles:definitions:save"]({
    accessToken,
    roleId: OWNER_ROLE_ID,
    ...payload,
  });
  return emitted;
}

const colourOf = async () => (await getRoleDefinition(OWNER_ROLE_ID))?.color ?? null;

describe("the owner role's colour", () => {
  it("saves when the owner sends a colour and nothing else", async () => {
    const emitted = await save(ownerToken, { color: "#ff0000" });
    assert.equal(refused(emitted), false, "the owner was refused their own colour");
    assert.equal(await colourOf(), "#ff0000");
  });

  it("can be cleared", async () => {
    await save(ownerToken, { color: "#ff0000" });
    const emitted = await save(ownerToken, { color: null });
    assert.equal(refused(emitted), false);
    assert.equal(await colourOf(), null);
    await save(ownerToken, { color: "#ff0000" });
  });
});

/* Every one of these asks for more than a colour and has to come back refused
   with the row untouched. */
describe("nothing else about the owner role", () => {
  const smuggled: [string, Record<string, unknown>][] = [
    ["a name beside the colour", { color: "#00ff00", name: "Boss" }],
    ["a rank beside the colour", { color: "#00ff00", rank: 99 }],
    ["permissions beside the colour", { color: "#00ff00", permissions: ["manage_roles"] }],
    ["an auto-grant beside the colour", { color: "#00ff00", autoGrantAfterDays: 1 }],
    ["invite-grantable beside the colour", { color: "#00ff00", grantableByInvite: true }],
    ["a name on its own", { name: "Boss" }],
    ["a rank on its own", { rank: 1 }],
    ["nothing at all", {}],
  ];

  for (const [what, payload] of smuggled) {
    it(`refuses ${what}`, async () => {
      const before = await colourOf();
      const emitted = await save(ownerToken, payload);
      assert.equal(refused(emitted), true, `${what} was not refused`);
      assert.equal(await colourOf(), before, `${what} changed the row anyway`);
    });
  }

  it("does not let the role grow a permission through the colour path", async () => {
    await save(ownerToken, { color: "#ff0000", permissions: ["manage_roles"] });
    const role = await getRoleDefinition(OWNER_ROLE_ID);
    assert.deepEqual(role?.permissions, seeded.permissions, "permissions were written by a colour save");
    assert.equal(role?.rank, seeded.rank, "rank was written by a colour save");
    assert.equal(role?.name, seeded.name, "name was written by a colour save");
  });
});

/* `manage_roles` alone would let a delegated admin recolour the owner into an
   ordinary member. Rank is the check the rest of the handler uses. */
describe("somebody below the owner", () => {
  it("cannot recolour it, even holding manage_roles", async () => {
    const before = await colourOf();
    const emitted = await save(adminToken, { color: "#0000ff" });
    assert.equal(refused(emitted), true, "a rank-50 admin recoloured the owner role");
    assert.equal(await colourOf(), before);
  });
});

/* Dropped rather than stored: `#fff`, `red` and `javascript:` all reach the
   client as a CSS value. */
describe("a colour that is not one", () => {
  for (const bad of ["red", "#fff", "#12345g", "javascript:alert(1)", "  ", 42, true]) {
    it(`falls back rather than storing ${JSON.stringify(bad)}`, async () => {
      await save(ownerToken, { color: "#ff0000" });
      await save(ownerToken, { color: bad });
      assert.equal(await colourOf(), "#ff0000");
    });
  }
});
