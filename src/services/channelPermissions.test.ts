import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "../db/sqlite/connection";
import { upsertServerChannel } from "../db/sqlite/channels";
import {
  createPermissionScope,
  replacePermissionRules,
  setChannelPermissionScope,
  deletePermissionTemplate,
  listPermissionTemplates,
} from "../db/sqlite/channelScopes";
import { migrateRankGatesToScopes, RANK_GATE_MIGRATION_KEY } from "../db/sqlite/rankGateMigration";
import { createRoleDefinition } from "../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { mayInChannel, mayViewChannel, resetChannelPermissionCache, scopedChannelIds, visibleChannelIds } from "./channelPermissions";

/**
 * Resolving a permission where the server-wide answer meets the channel's.
 *
 * Three states, and the interesting cases are all about the third: inherit is
 * the absence of a rule, so most of these check that *not* saying something
 * leaves the server-wide answer exactly as it was. A model that quietly turned
 * "no rule" into "denied" would lock every channel on the server the first time
 * anybody set one cell.
 */

let dir: string;

const OPEN = "open-chan";
const LOCKED = "locked-chan";
const GRANTING = "granting-chan";

let lowUser = "";
let highUser = "";
let ownerUser = "";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-chanperms-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await createRoleDefinition("low", { name: "Low", rank: 10, permissions: ["read_messages", "send_messages"] });
  // Deliberately without send_messages, so an allow rule has something to grant.
  await createRoleDefinition("high", { name: "High", rank: 80, permissions: ["read_messages"] });

  const low = await upsertUser("acct-low", "Low");
  await setServerRole(low.server_user_id, "low");
  lowUser = low.server_user_id;

  const high = await upsertUser("acct-high", "High");
  await setServerRole(high.server_user_id, "high");
  highUser = high.server_user_id;

  const owner = await upsertUser("acct-owner", "Owner");
  await setServerRole(owner.server_user_id, "owner");
  ownerUser = owner.server_user_id;
  getSqliteDb().prepare(`UPDATE server_config SET owner_gryt_user_id = ?`).run("acct-owner");

  await upsertServerChannel({ channelId: OPEN, name: "Open", type: "text" });
  await upsertServerChannel({ channelId: LOCKED, name: "Locked", type: "text" });
  await upsertServerChannel({ channelId: GRANTING, name: "Granting", type: "text" });

  const locked = await createPermissionScope({ name: "Staff only", isTemplate: true });
  await replacePermissionRules(locked, [{ roleId: "low", permission: "read_messages", effect: "deny" }]);
  await setChannelPermissionScope(LOCKED, locked);

  const granting = await createPermissionScope({ isTemplate: false });
  await replacePermissionRules(granting, [{ roleId: "high", permission: "send_messages", effect: "allow" }]);
  await setChannelPermissionScope(GRANTING, granting);

  resetChannelPermissionCache();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a channel with no scope", () => {
  it("gives every role exactly what the server gave it", async () => {
    assert.equal(await mayInChannel(OPEN, lowUser, "send_messages"), true);
    assert.equal(await mayInChannel(OPEN, highUser, "send_messages"), false, "high has no send_messages server-wide");
  });

  it("is visible to anybody who may read at all", async () => {
    assert.ok((await visibleChannelIds(lowUser)).has(OPEN));
    assert.ok((await visibleChannelIds(highUser)).has(OPEN));
  });
});

describe("deny", () => {
  it("takes a permission the role holds server-wide", async () => {
    assert.equal(await mayInChannel(LOCKED, lowUser, "read_messages"), false);
    assert.equal(await mayViewChannel(LOCKED, lowUser), false);
  });

  it("leaves everything it does not mention alone", async () => {
    // The scope denies read_messages for `low` and says nothing about
    // send_messages. Inheriting has to mean inheriting — a model that read one
    // rule as "this scope now decides everything" would deny posting too.
    assert.equal(await mayInChannel(LOCKED, lowUser, "send_messages"), true);
  });

  it("says nothing about a role it does not name", async () => {
    assert.equal(await mayViewChannel(LOCKED, highUser), true);
    assert.ok((await visibleChannelIds(highUser)).has(LOCKED));
  });

  it("hides the channel rather than marking it locked", async () => {
    assert.ok(!(await visibleChannelIds(lowUser)).has(LOCKED));
  });
});

describe("allow", () => {
  it("grants a permission the role does not hold server-wide", async () => {
    // This is what makes allow worth having: `high` cannot post anywhere, and
    // in this one channel it can.
    assert.equal(await mayInChannel(GRANTING, highUser, "send_messages"), true);
    assert.equal(await mayInChannel(OPEN, highUser, "send_messages"), false);
  });
});

describe("the owner", () => {
  it("is not gated by a scope that denies their role", async () => {
    assert.equal(await mayViewChannel(LOCKED, ownerUser), true);
    assert.equal(await mayInChannel(LOCKED, ownerUser, "send_messages"), true);
  });

  it("sees every channel", async () => {
    const visible = await visibleChannelIds(ownerUser);
    for (const id of [OPEN, LOCKED, GRANTING]) assert.ok(visible.has(id), `owner cannot see ${id}`);
  });
});

describe("nobody", () => {
  it("gets nothing before they have proved who they are", async () => {
    assert.equal(await mayViewChannel(OPEN, "temp_12345"), false);
    assert.equal((await visibleChannelIds("temp_12345")).size, 0);
    assert.equal((await visibleChannelIds(null)).size, 0);
  });
});

describe("an id that is not a channel", () => {
  it("is visible, because a direct message has no scope to clear", async () => {
    // `resolveConversationAccess` asks this about every conversation id it
    // sees. Treating an unknown id as hidden would lock every DM on the server.
    assert.equal(await mayViewChannel("dm_0123456789abcdef", lowUser), true);
  });
});

describe("the fast path for a server that uses none of this", () => {
  it("reports only the channels that actually point at a scope", async () => {
    const scoped = await scopedChannelIds();
    assert.ok(scoped.has(LOCKED));
    assert.ok(scoped.has(GRANTING));
    assert.ok(!scoped.has(OPEN), "an unscoped channel must not put the broadcasts on the slow path");
  });
});

describe("switching a channel away from a custom scope", () => {
  it("takes the private scope with it, and leaves a shared template alone", async () => {
    const db = getSqliteDb();
    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM channel_permission_scopes WHERE is_template = 0`)
      .get() as { n: number };

    await setChannelPermissionScope(GRANTING, null);
    resetChannelPermissionCache();

    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM channel_permission_scopes WHERE is_template = 0`)
      .get() as { n: number };
    assert.equal(after.n, before.n - 1, "the channel's own scope should have gone with it");

    // The template LOCKED points at is shared, so it survives its channel
    // being repointed.
    await setChannelPermissionScope(LOCKED, null);
    resetChannelPermissionCache();
    assert.equal((await listPermissionTemplates()).length, 1, "a template must outlive the channels using it");

    // Put it back for anything that runs after this.
    const templates = await listPermissionTemplates();
    await setChannelPermissionScope(LOCKED, templates[0].scope_id);
    resetChannelPermissionCache();
  });
});

describe("deleting a template", () => {
  it("puts its channels back to inheriting rather than leaving them dangling", async () => {
    const doomed = await createPermissionScope({ name: "Doomed", isTemplate: true });
    await replacePermissionRules(doomed, [{ roleId: "low", permission: "read_messages", effect: "deny" }]);
    await setChannelPermissionScope(OPEN, doomed);
    resetChannelPermissionCache();
    assert.equal(await mayViewChannel(OPEN, lowUser), false);

    await deletePermissionTemplate(doomed);
    resetChannelPermissionCache();

    // Visible again, and — the part that matters — through a null scope rather
    // than through a scope id that no longer resolves. Both answer "visible",
    // but only one of them leaves the editor with a dropdown pointing at
    // nothing.
    assert.equal(await mayViewChannel(OPEN, lowUser), true);
    assert.ok(!(await scopedChannelIds()).has(OPEN));
  });
});

describe("the rank gate migration, against a real database", () => {
  it("runs once and refuses to run again", async () => {
    const db = getSqliteDb();

    // initSqlite already ran it, so the marker is set and a second call is a
    // no-op. That is the safety property: a second pass would rebuild scopes
    // from rank columns for channels somebody has since edited by hand.
    const marker = db
      .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
      .get(RANK_GATE_MIGRATION_KEY) as { value: string } | undefined;
    assert.ok(marker, "the migration should have recorded that it ran");

    db.prepare(`UPDATE channels SET post_min_rank = 80 WHERE channel_id = ?`).run(OPEN);
    assert.equal(migrateRankGatesToScopes(db), 0, "a second run must convert nothing");

    const stillNoScope = db
      .prepare(`SELECT permission_scope_id FROM channels WHERE channel_id = ?`)
      .get(OPEN) as { permission_scope_id: string | null };
    assert.equal(stillNoScope.permission_scope_id, null);

    db.prepare(`UPDATE channels SET post_min_rank = NULL WHERE channel_id = ?`).run(OPEN);
  });

  it("converts a gate when the marker is not there", async () => {
    const db = getSqliteDb();
    db.prepare(`DELETE FROM schema_meta WHERE key = ?`).run(RANK_GATE_MIGRATION_KEY);
    db.prepare(`UPDATE channels SET view_min_rank = 50 WHERE channel_id = ?`).run(OPEN);

    assert.equal(migrateRankGatesToScopes(db), 1);
    resetChannelPermissionCache();

    // `low` is rank 10 and below the old gate of 50, so the channel is gone
    // for them exactly as it was before the upgrade.
    assert.equal(await mayViewChannel(OPEN, lowUser), false);
    assert.equal(await mayViewChannel(OPEN, highUser), true, "rank 80 was above the gate and still is");
  });
});
