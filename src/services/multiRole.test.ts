import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import {
  addMemberRole,
  claimServerOwner,
  listMemberRoles,
  listServerRoles,
  removeMemberRole,
  setMemberRoles,
  setServerRole,
} from "../db/sqlite/servers";
import {
  createRoleDefinition,
  countRoleHolders,
  reassignRoleHolders,
} from "../db/sqlite/roleDefinitions";
import { upsertUser } from "../db/sqlite/users";
import { getEffectiveStanding } from "./permissions";

/**
 * Holding more than one role, which the roles table could not represent until
 * its primary key grew a column.
 */
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-multirole-"));
  process.env.DATA_DIR = dir;
  await initSqlite();

  // Two roles that overlap in neither permission, so a union is visible.
  await createRoleDefinition("scribe", {
    name: "Scribe",
    rank: 20,
    permissions: ["read_messages", "send_messages"],
  });
  await createRoleDefinition("janitor", {
    name: "Janitor",
    rank: 40,
    permissions: ["read_messages", "manage_messages"],
  });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("holding several roles", () => {
  it("keeps both rather than replacing", async () => {
    const user = await upsertUser("key:multi-1", "Ada");
    await setServerRole(user.server_user_id, "scribe");
    await addMemberRole(user.server_user_id, "janitor");

    assert.deepEqual(
      (await listMemberRoles(user.server_user_id)).sort(),
      ["janitor", "scribe"],
    );
  });

  it("adds up what they may do", async () => {
    const user = await upsertUser("key:multi-2", "Tor");
    await setMemberRoles(user.server_user_id, ["scribe", "janitor"]);

    const standing = await getEffectiveStanding(user.server_user_id);
    assert.equal(standing.permissions.has("send_messages"), true, "from scribe");
    assert.equal(standing.permissions.has("manage_messages"), true, "from janitor");
  });

  it("puts them at the highest rank they hold", async () => {
    const user = await upsertUser("key:multi-3", "Mia");
    await setMemberRoles(user.server_user_id, ["scribe", "janitor"]);

    const standing = await getEffectiveStanding(user.server_user_id);
    assert.equal(standing.rank, 40);
    // And the one drawn next to their name is the one that rank came from.
    assert.equal(standing.roleId, "janitor");
    assert.deepEqual(standing.roleIds, ["janitor", "scribe"]);
  });

  it("does not care what order they were given in", async () => {
    const user = await upsertUser("key:multi-4", "Kai");
    await setServerRole(user.server_user_id, "janitor");
    await addMemberRole(user.server_user_id, "scribe");

    const standing = await getEffectiveStanding(user.server_user_id);
    assert.equal(standing.roleId, "janitor");
  });

  it("gives the same role twice once", async () => {
    const user = await upsertUser("key:multi-5", "Rin");
    await addMemberRole(user.server_user_id, "scribe");
    await addMemberRole(user.server_user_id, "scribe");

    assert.deepEqual(await listMemberRoles(user.server_user_id), ["scribe"]);
  });

  it("takes one away and leaves the rest", async () => {
    const user = await upsertUser("key:multi-6", "Eli");
    await setMemberRoles(user.server_user_id, ["scribe", "janitor"]);

    assert.equal(await removeMemberRole(user.server_user_id, "janitor"), true);
    assert.deepEqual(await listMemberRoles(user.server_user_id), ["scribe"]);

    const standing = await getEffectiveStanding(user.server_user_id);
    assert.equal(standing.permissions.has("manage_messages"), false);
    assert.equal(standing.permissions.has("send_messages"), true);
  });

  it("drops somebody with no roles left onto the joining default", async () => {
    const user = await upsertUser("key:multi-7", "Nor");
    await setServerRole(user.server_user_id, "scribe");
    await removeMemberRole(user.server_user_id, "scribe");

    assert.deepEqual(await listMemberRoles(user.server_user_id), []);
    // Not nothing: the same place somebody who has never been given a role
    // sits, which for a local identity is the local default.
    const standing = await getEffectiveStanding(user.server_user_id);
    assert.equal(standing.permissions.has("read_messages"), true);
  });

  it("replaces the set when told to set one", async () => {
    const user = await upsertUser("key:multi-8", "Vex");
    await setMemberRoles(user.server_user_id, ["scribe", "janitor"]);
    await setServerRole(user.server_user_id, "scribe");

    assert.deepEqual(await listMemberRoles(user.server_user_id), ["scribe"]);
  });

  it("lets the owner hold something else as well", async () => {
    const owner = await upsertUser("key:multi-owner", "Sivert");
    await claimServerOwner(owner.gryt_user_id);
    await setMemberRoles(owner.server_user_id, ["owner", "scribe"]);

    const standing = await getEffectiveStanding(owner.server_user_id, owner.gryt_user_id);
    assert.equal(standing.isOwner, true);
    assert.equal(standing.roleId, "owner", "still shown as the owner");
    assert.ok(standing.roleIds.includes("scribe"), "and keeps the other one");
  });

  it("counts a role's holders as people, not rows", async () => {
    // Every user above who holds scribe, counted once each even though several
    // of them hold janitor too.
    const before = await countRoleHolders("scribe");
    const user = await upsertUser("key:multi-9", "Ola");
    await setMemberRoles(user.server_user_id, ["scribe", "janitor"]);
    assert.equal(await countRoleHolders("scribe"), before + 1);
  });

  it("survives being reassigned onto a role somebody already holds", async () => {
    // The case the old single UPDATE could not do: renaming scribe to janitor
    // for somebody who is both would collide on the primary key.
    await createRoleDefinition("temp", { name: "Temp", rank: 10, permissions: [] });
    const both = await upsertUser("key:multi-10", "Ivy");
    await setMemberRoles(both.server_user_id, ["temp", "janitor"]);
    const onlyTemp = await upsertUser("key:multi-11", "Jo");
    await setMemberRoles(onlyTemp.server_user_id, ["temp"]);

    const { moved } = await reassignRoleHolders("temp", "janitor");
    assert.equal(moved, 2);

    assert.deepEqual(await listMemberRoles(both.server_user_id), ["janitor"]);
    assert.deepEqual(await listMemberRoles(onlyTemp.server_user_id), ["janitor"]);
    assert.equal(
      (await listServerRoles()).some((r) => r.role === "temp"),
      false,
      "nobody left holding it",
    );
  });
});
