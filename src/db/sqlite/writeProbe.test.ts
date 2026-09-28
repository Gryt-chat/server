import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite, probeSqliteWrite } from "./connection";

let dir: string;
const isRoot = process.getuid?.() === 0;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-write-probe-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  chmodSync(join(dir, "gryt.db"), 0o644);
  rmSync(dir, { recursive: true, force: true });
});

describe("probeSqliteWrite", () => {
  it("answers ok and leaves nothing behind", () => {
    assert.equal(probeSqliteWrite(), "ok");
    const row = getSqliteDb().prepare("SELECT 1 FROM schema_meta WHERE key = 'write_probe'").get();
    assert.equal(row, undefined);
  });

  it("answers busy at once while another connection holds the write lock", () => {
    const other = new DatabaseSync(join(dir, "gryt.db"));
    other.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      assert.equal(probeSqliteWrite(), "busy");
      assert.ok(performance.now() - started < 1000, "the probe waited on busy_timeout");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    const timeout = getSqliteDb().prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(timeout.timeout, 5000);
    assert.equal(probeSqliteWrite(), "ok");
  });

  it("answers failed on a connection SQLite opened read-only", { skip: isRoot }, () => {
    const path = join(dir, "readonly.db");
    const setup = new DatabaseSync(path);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    setup.close();
    chmodSync(path, 0o444);
    // No error here: SQLite falls back to read-only without saying so.
    const readOnly = new DatabaseSync(path);
    try {
      assert.equal(readOnly.prepare("SELECT count(*) AS n FROM schema_meta").get()?.n, 0);
      assert.equal(probeSqliteWrite(readOnly), "failed");
    } finally {
      readOnly.close();
      chmodSync(path, 0o644);
    }
  });

  it("never lets a read-only gryt.db through as healthy", { skip: isRoot }, async () => {
    getSqliteDb().close();
    chmodSync(join(dir, "gryt.db"), 0o444);
    const init = await initSqlite().then(
      () => "opened",
      () => "failed",
    );
    if (init === "opened") assert.equal(probeSqliteWrite(), "failed");
  });
});
