import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { DEFAULT_FILESYSTEM_BUCKET, ensureBucket, initStorage, putObject } from "./index";

/** GRYT-1443: the CLI set STORAGE_BACKEND=filesystem with no S3_BUCKET, and every
    upload answered 500 "S3_BUCKET not configured". */

const saved = { ...process.env };
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gryt-fsbucket-"));
});

beforeEach(() => {
  process.env.DATA_DIR = dir;
  process.env.STORAGE_BACKEND = "filesystem";
  delete process.env.S3_BUCKET;
});

after(() => {
  for (const key of ["DATA_DIR", "STORAGE_BACKEND", "S3_BUCKET"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("filesystem storage with no S3_BUCKET", () => {
  it("names the folder gryt, so uploads have somewhere to go", async () => {
    initStorage();
    assert.equal(process.env.S3_BUCKET, DEFAULT_FILESYSTEM_BUCKET);
    assert.equal(DEFAULT_FILESYSTEM_BUCKET, "gryt", "the image worker and the compose files expect this name");

    await ensureBucket(process.env.S3_BUCKET!);
    await putObject({ bucket: process.env.S3_BUCKET!, key: "uploads/a.txt", body: "a", contentType: "text/plain" });
    assert.ok(existsSync(join(dir, "gryt", "uploads", "a.txt")));
  });

  it("treats a blank value as unset", () => {
    process.env.S3_BUCKET = "  ";
    initStorage();
    assert.equal(process.env.S3_BUCKET, "gryt");
  });

  it("keeps a folder somebody chose", () => {
    process.env.S3_BUCKET = "uploads";
    initStorage();
    assert.equal(process.env.S3_BUCKET, "uploads");
  });
});
