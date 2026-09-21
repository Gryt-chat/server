import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { mayViewChannel, resetChannelPermissionCache } from "../../services/channelPermissions";
import { listServerChannels, listServerSidebarItems, upsertServerChannel, upsertServerSidebarItem } from "./channels";
import { createPermissionScope, replacePermissionRules, setFolderPermissionScope } from "./channelScopes";
import { getSqliteDb, initSqlite } from "./connection";
import { createRoleDefinition } from "./roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "./servers";
import { upsertUser } from "./users";

/** A database from the build before folder permissions, upgraded in place: every
    channel has to answer as it did, a scoped one inside a folder included. */

let dir: string;
let lowUser = "";

const SCOPED = "mig-scoped";
const PLAIN = "mig-plain";
const TOP = "mig-top";
const FOLDER = "mig-folder";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-foldermig-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await createRoleDefinition("mig-low", { name: "Low", rank: 10, permissions: ["read_messages", "send_messages"] });
  const low = await upsertUser("acct-mig-low", "Low");
  await setServerRole(low.server_user_id, "mig-low");
  lowUser = low.server_user_id;

  // Back to the previous release's shape, then filled the way it filled it.
  const db = getSqliteDb();
  db.exec("ALTER TABLE channels DROP COLUMN follows_folder");
  db.exec("ALTER TABLE sidebar_items DROP COLUMN permission_scope_id");

  await upsertServerChannel({ channelId: SCOPED, name: "Scoped", type: "text" });
  await upsertServerChannel({ channelId: PLAIN, name: "Plain", type: "text" });
  await upsertServerChannel({ channelId: TOP, name: "Top", type: "text" });
  await upsertServerSidebarItem({ itemId: FOLDER, kind: "folder", label: "Old folder", position: 10 });
  await upsertServerSidebarItem({ itemId: "sb-scoped", kind: "channel", channelId: SCOPED, position: 20, parentItemId: FOLDER });
  await upsertServerSidebarItem({ itemId: "sb-plain", kind: "channel", channelId: PLAIN, position: 30, parentItemId: FOLDER });
  await upsertServerSidebarItem({ itemId: "sb-top", kind: "channel", channelId: TOP, position: 40 });

  const hidden = await createPermissionScope({ name: "Hidden from low", isTemplate: true });
  await replacePermissionRules(hidden, [{ roleId: "mig-low", permission: "read_messages", effect: "deny" }]);
  db.prepare(`UPDATE channels SET permission_scope_id = ? WHERE channel_id = ?`).run(hidden, SCOPED);

  await initSqlite();
  resetChannelPermissionCache();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("upgrading a server that has folders", () => {
  it("adds both columns with nothing in the folder's", async () => {
    const channels = await listServerChannels();
    assert.ok(channels.every((c) => c.follows_folder), "every channel starts out following");
    const folder = (await listServerSidebarItems()).find((i) => i.item_id === FOLDER);
    assert.equal(folder?.permission_scope_id, null);
  });

  it("answers every channel as it did before", async () => {
    assert.equal(await mayViewChannel(SCOPED, lowUser), false, "a scoped channel in a folder lost its scope");
    assert.equal(await mayViewChannel(PLAIN, lowUser), true);
    assert.equal(await mayViewChannel(TOP, lowUser), true);
  });

  it("gives the folder's scope to the unscoped channel only, once it has one", async () => {
    const staff = await createPermissionScope({ isTemplate: false });
    await replacePermissionRules(staff, [{ roleId: "mig-low", permission: "read_messages", effect: "deny" }]);
    await setFolderPermissionScope(FOLDER, staff);
    resetChannelPermissionCache();

    assert.equal(await mayViewChannel(PLAIN, lowUser), false, "the unscoped channel should follow its folder");
    assert.equal(await mayViewChannel(TOP, lowUser), true, "a channel outside the folder is not in it");

    const open = await createPermissionScope({ isTemplate: false });
    await setFolderPermissionScope(FOLDER, open);
    resetChannelPermissionCache();
    assert.equal(await mayViewChannel(SCOPED, lowUser), false, "a scope of its own has to beat the folder's");
  });
});
