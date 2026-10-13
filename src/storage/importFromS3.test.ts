import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";

import { IMPORT_MARKER, ImportError, importFromS3, needsS3Import, type S3Source } from "./importFromS3";

const KEYS = ["DATA_DIR", "S3_BUCKET", "S3_ENDPOINT", "STORAGE_BACKEND", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;

function fakeBucket(objects: Record<string, { body: string; type?: string }>, lie?: string): S3Source & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    async *list() {
      for (const [key, o] of Object.entries(objects)) yield { key, size: Buffer.byteLength(o.body) + (key === lie ? 1 : 0) };
    },
    async get(key) {
      gets.push(key);
      return { body: Readable.from([Buffer.from(objects[key].body)]), contentType: objects[key].type };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gryt-s3-import-"));
  for (const k of KEYS) delete process.env[k];
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt";
  process.env.S3_ENDPOINT = "http://minio:9000";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("copying an old S3 bucket to disk", () => {
  it("copies every object with its content type, then marks the folder done", async () => {
    assert.equal(needsS3Import(), true);
    const source = fakeBucket({
      "uploads/a.png": { body: "png bytes", type: "image/png" },
      "emojis/b.gif": { body: "gif", type: "image/gif" },
    });
    const result = await importFromS3(source, () => {});
    assert.deepEqual(result, { copied: 2, skipped: 0 });
    assert.equal(readFileSync(join(dir, "gryt/uploads/a.png"), "utf8"), "png bytes");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "gryt/uploads/a.png.meta"), "utf8")), { contentType: "image/png" });
    assert.ok(existsSync(join(dir, "gryt", IMPORT_MARKER)));
    assert.equal(needsS3Import(), false, "it would copy again on every start");
  });

  it("skips what an interrupted run already copied", async () => {
    const objects = { "uploads/a.png": { body: "one", type: "image/png" }, "uploads/b.png": { body: "two" } };
    await importFromS3(fakeBucket(objects), () => {});
    rmSync(join(dir, "gryt", IMPORT_MARKER));
    const again = fakeBucket(objects);
    assert.deepEqual(await importFromS3(again, () => {}), { copied: 0, skipped: 2 });
    assert.deepEqual(again.gets, []);
  });

  it("refuses a key that would land outside the folder, before copying anything", async () => {
    const source = fakeBucket({ "uploads/ok.png": { body: "x" }, "../../etc/passwd": { body: "y" } });
    await assert.rejects(importFromS3(source, () => {}), ImportError);
    assert.deepEqual(source.gets, []);
    assert.equal(existsSync(join(dir, "gryt", IMPORT_MARKER)), false);
  });

  it("stops without a marker when a download comes back short", async () => {
    const source = fakeBucket({ "uploads/a.png": { body: "short" } }, "uploads/a.png");
    await assert.rejects(importFromS3(source, () => {}), /bytes/);
    assert.equal(existsSync(join(dir, "gryt/uploads/a.png")), false);
    assert.equal(existsSync(join(dir, "gryt", IMPORT_MARKER)), false);
  });

  it("has nothing to do for a server with no S3 settings", () => {
    delete process.env.S3_ENDPOINT;
    assert.equal(needsS3Import(), false);
  });
});
