import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import {
  claimServerOwner,
  getServerRole,
  setServerRole,
  updateServerConfig,
} from "../db/sqlite/servers";
import {
  createRoleDefinition,
  deleteRoleDefinition,
  getRoleDefinition,
  listRoleDefinitions,
  updateRoleDefinition,
} from "../db/sqlite/roleDefinitions";
import { upsertUser } from "../db/sqlite/users";
import { getEffectiveStanding, hasPermission } from "./permissions";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-perms-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("built-in roles", () => {
  it("seeds the five every server starts with", async () => {
    const ids = (await listRoleDefinitions()).map((r) => r.role_id);
    for (const id of ["owner", "admin", "mod", "member", "guest"]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });

  it("keeps admin short of the two that were owner-only", async () => {
    // The property that matters on upgrade: this change must not hand an
    // existing admin anything they did not already have.
    const admin = await getRoleDefinition("admin");
    assert.ok(admin);
    assert.equal(admin.permissions.includes("manage_roles"), false);
    assert.equal(admin.permissions.includes("manage_server"), false);
    assert.equal(admin.permissions.includes("ban_members"), true);
  });

  it("gives a moderator only what the mod gates allowed", async () => {
    const mod = await getRoleDefinition("mod");
    assert.ok(mod);
    assert.equal(mod.permissions.includes("kick_members"), true);
    assert.equal(mod.permissions.includes("mute_members"), true);
    // Bans, reports and the audit log were admin, and stay admin.
    assert.equal(mod.permissions.includes("ban_members"), false);
    assert.equal(mod.permissions.includes("manage_reports"), false);
  });

  it("makes a guest read-only", async () => {
    const guest = await getRoleDefinition("guest");
    assert.deepEqual(guest?.permissions, []);
  });
});

describe("resolving what somebody may do", () => {
  it("reads the permissions of the role they hold", async () => {
    const user = await upsertUser("account-member", "Mia");
    await setServerRole(user.server_user_id, "member");

    assert.equal(await hasPermission(user.server_user_id, "send_messages"), true);
    assert.equal(await hasPermission(user.server_user_id, "ban_members"), false);
  });

  it("follows an edit to the role, not a copy taken at join", async () => {
    const user = await upsertUser("account-edited", "Eve");
    await setServerRole(user.server_user_id, "member");
    assert.equal(await hasPermission(user.server_user_id, "attach_files"), true);

    await updateRoleDefinition("member", {
      permissions: ["send_messages", "add_reactions"],
    });

    assert.equal(await hasPermission(user.server_user_id, "attach_files"), false);
    assert.equal(await hasPermission(user.server_user_id, "send_messages"), true);

    await updateRoleDefinition("member", {
      permissions: [
        "send_messages",
        "attach_files",
        "add_reactions",
        "join_voice",
        "speak",
        "share_video",
        "share_screen",
        "change_nickname",
        "change_avatar",
      ],
    });
  });

  it("gives the config owner everything, whatever their roles row says", async () => {
    const owner = await upsertUser("account-owner", "Ola");
    await claimServerOwner("account-owner");
    // Deliberately the weakest role there is. Ownership is a property of the
    // server, and the row is only a cache of it.
    await setServerRole(owner.server_user_id, "guest");

    const standing = await getEffectiveStanding(owner.server_user_id, "account-owner");
    assert.equal(standing.isOwner, true);
    assert.equal(standing.permissions.has("manage_server"), true);
  });

  it("falls back to the joining default when the role was deleted", async () => {
    await createRoleDefinition("contributor", {
      name: "Contributor",
      rank: 30,
      permissions: ["send_messages"],
    });
    const user = await upsertUser("key:contributor", "Kim");
    await setServerRole(user.server_user_id, "contributor");
    assert.equal(await hasPermission(user.server_user_id, "send_messages"), true);

    // A local-tier id, so the local default is the one that should apply.
    await updateServerConfig({ defaultRoleLocal: "guest" });
    await deleteRoleDefinition("contributor", "guest");

    assert.equal(await hasPermission(user.server_user_id, "send_messages"), false);
    const standing = await getEffectiveStanding(user.server_user_id);
    assert.equal(standing.roleId, "guest");
  });

  it("refuses to delete a built-in", async () => {
    const result = await deleteRoleDefinition("member", "guest");
    assert.deepEqual(result, { deleted: false, moved: 0 });
    assert.ok(await getRoleDefinition("member"));
  });
});

describe("joining defaults", () => {
  it("splits accounts from keys", async () => {
    await updateServerConfig({
      defaultRoleAccount: "member",
      defaultRoleLocal: "guest",
    });

    // Nobody has a roles row yet, so both resolve through the default.
    const account = await upsertUser("account-fresh", "Ann");
    const local = await upsertUser("key:fresh", "Kaz");

    assert.equal((await getEffectiveStanding(account.server_user_id)).roleId, "member");
    assert.equal((await getEffectiveStanding(local.server_user_id)).roleId, "guest");

    assert.equal(await getServerRole(account.server_user_id), null, "no row written by a read");
  });
});
