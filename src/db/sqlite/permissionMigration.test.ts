import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BUILT_IN_ROLES } from "../../constants/permissions";
import { getSqliteDb, initSqlite } from "./connection";
import { getRoleDefinition, createRoleDefinition } from "./roleDefinitions";

/**
 * The backfill as it actually runs, rather than as a pure function.
 *
 * `permissionBackfill.test.ts` proves the mapping is right. This proves the
 * wiring is: that the stamp is read and written, that a database left at an
 * older version gets swept on the next start, and that one already at the
 * current version is left alone.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-permmig-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** Put the database back the way a server running the previous release left it. */
function rewindToVersion1(): void {
  const db = getSqliteDb();
  db.prepare(`UPDATE schema_meta SET value = '1' WHERE key = 'permission_schema_version'`).run();
  db.prepare(`UPDATE role_definitions SET permissions = ? WHERE role_id = 'guest'`).run("[]");
  db.prepare(`UPDATE role_definitions SET permissions = ? WHERE role_id = 'member'`).run(
    JSON.stringify([
      "send_messages",
      "attach_files",
      "add_reactions",
      "join_voice",
      "speak",
      "share_video",
      "share_screen",
      "change_nickname",
      "change_avatar",
    ]),
  );
}

describe("the permission backfill on start", () => {
  it("stamps a fresh database at the current version", () => {
    const db = getSqliteDb();
    const row = db
      .prepare(`SELECT value FROM schema_meta WHERE key = 'permission_schema_version'`)
      .get() as { value: string } | undefined;
    assert.equal(row?.value, "2");
  });

  it("sweeps a database left at the previous version", async () => {
    rewindToVersion1();
    // A role the operator made, holding what a contributor might have held.
    await createRoleDefinition("contributor-v1", {
      name: "Contributor",
      rank: 30,
      permissions: ["send_messages"],
    });
    getSqliteDb()
      .prepare(`UPDATE role_definitions SET permissions = ? WHERE role_id = 'contributor-v1'`)
      .run(JSON.stringify(["send_messages"]));

    await initSqlite();

    const guest = await getRoleDefinition("guest");
    assert.deepEqual(
      [...(guest?.permissions ?? [])].sort(),
      [...(BUILT_IN_ROLES.find((r) => r.id === "guest")?.permissions ?? [])].sort(),
      "guest ends where a fresh server would seed it",
    );

    const member = await getRoleDefinition("member");
    assert.deepEqual(
      [...(member?.permissions ?? [])].sort(),
      [...(BUILT_IN_ROLES.find((r) => r.id === "member")?.permissions ?? [])].sort(),
      "member ends where a fresh server would seed it",
    );

    const custom = await getRoleDefinition("contributor-v1");
    assert.ok(custom);
    // Keeps what it had, gains what it could already do, and nothing else.
    assert.equal(custom.permissions.includes("send_messages"), true);
    assert.equal(custom.permissions.includes("read_messages"), true);
    assert.equal(custom.permissions.includes("edit_own_messages"), true);
    assert.equal(custom.permissions.includes("attach_files"), false);
    assert.equal(custom.permissions.includes("join_voice"), false);
  });

  it("leaves an already-current database alone", async () => {
    // Somebody has since decided members may not attach files. A second start
    // must not undo that.
    getSqliteDb()
      .prepare(`UPDATE role_definitions SET permissions = ? WHERE role_id = 'member'`)
      .run(JSON.stringify(["read_messages", "send_messages"]));

    await initSqlite();

    const member = await getRoleDefinition("member");
    assert.deepEqual([...(member?.permissions ?? [])].sort(), [
      "read_messages",
      "send_messages",
    ]);
  });
});
