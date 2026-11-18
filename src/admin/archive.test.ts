import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { exportServer, importServer } from "./archive";

function server(): { dir: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "gryt-archive-src-"));
  const db = new DatabaseSync(join(dir, "gryt.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
  writeFileSync(join(dir, "server-identity-key.json"), '{"k":1}');
  mkdirSync(join(dir, "gryt"));
  writeFileSync(join(dir, "gryt", "file-1"), "bytes");
  return { dir, db };
}

test("an export of a running server comes back whole on a fresh one", () => {
  const { dir, db } = server();
  const out = join(mkdtempSync(join(tmpdir(), "gryt-archive-out-")), "s.tar.gz");
  exportServer(dir, out, "1.2.3");
  db.close();

  const fresh = join(mkdtempSync(join(tmpdir(), "gryt-archive-dst-")), "data");
  const manifest = importServer(fresh, out);
  assert.equal(manifest.serverVersion, "1.2.3");
  const copy = new DatabaseSync(join(fresh, "gryt.db"));
  assert.deepEqual(copy.prepare("SELECT v FROM t").all().map((r) => r.v), ["kept"]);
  copy.close();
  assert.equal(readFileSync(join(fresh, "server-identity-key.json"), "utf8"), '{"k":1}');
  assert.equal(readFileSync(join(fresh, "gryt", "file-1"), "utf8"), "bytes");
  assert.equal(existsSync(join(fresh, "gryt-export.json")), false);
});

test("uploads land in the folder the importing server reads", () => {
  const { dir, db } = server();
  const out = join(mkdtempSync(join(tmpdir(), "gryt-archive-out-")), "s.tar.gz");
  exportServer(dir, out);
  db.close();

  const fresh = join(mkdtempSync(join(tmpdir(), "gryt-archive-dst-")), "data");
  process.env.S3_BUCKET = "old-bucket";
  try {
    importServer(fresh, out);
  } finally {
    delete process.env.S3_BUCKET;
  }
  assert.equal(readFileSync(join(fresh, "old-bucket", "file-1"), "utf8"), "bytes");
});

test("an import never writes over an existing server", () => {
  const { dir, db } = server();
  db.close();
  assert.throws(() => importServer(dir, join(dir, "gryt.db")), /not empty/);
});
