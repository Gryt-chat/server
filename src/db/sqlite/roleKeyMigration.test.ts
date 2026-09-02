import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { addMemberRole, listMemberRoles } from "./servers";

/**
 * Upgrading a database written before a member could hold two roles.
 *
 * The old table keyed on server_user_id alone, and SQLite cannot widen a
 * primary key in place — so this is a rebuild, and the thing worth proving is
 * that the rows come out the other side. A migration that quietly emptied this
 * table would leave every member on the joining default, which reads as the
 * server having forgotten who its moderators are.
 */
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-rolekey-"));

  // A database in the old shape, written before initSqlite ever sees it.
  const old = new DatabaseSync(join(dir, "gryt.db"));
  old.exec(`
    CREATE TABLE roles (
      server_user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO roles (server_user_id, role, created_at, updated_at) VALUES
      ('su_ada', 'admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('su_tor', 'mod',   '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  `);
  old.close();

  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("widening the roles key", () => {
  it("keeps everybody's role", async () => {
    assert.deepEqual(await listMemberRoles("su_ada"), ["admin"]);
    assert.deepEqual(await listMemberRoles("su_tor"), ["mod"]);
  });

  it("lets somebody hold a second one afterwards", async () => {
    await addMemberRole("su_ada", "mod");
    assert.deepEqual((await listMemberRoles("su_ada")).sort(), ["admin", "mod"]);
  });

  it("leaves the key wide", async () => {
    const db = new DatabaseSync(join(dir, "gryt.db"), { readOnly: true });
    const cols = db.prepare("PRAGMA table_info(roles)").all() as unknown as {
      name: string;
      pk: number;
    }[];
    db.close();

    const keyed = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    assert.deepEqual(keyed, ["role", "server_user_id"]);
  });
});
