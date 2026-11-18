/* eslint-disable @typescript-eslint/no-restricted-types -- a stand-in for Express's Response in a test */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { insertFile } from "../db/sqlite/messages";
import { planStorageBytes, refusedForStorage } from "./storageLimit";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-storage-limit-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  delete process.env.GRYT_PLAN_STORAGE_BYTES;
  rmSync(dir, { recursive: true, force: true });
});

function fakeRes() {
  const sent: { status?: number; body?: { error?: string; message?: string } } = {};
  const res = {
    status(code: number) { sent.status = code; return res; },
    json(body: { error?: string; message?: string }) { sent.body = body; return res; },
  };
  return { res: res as unknown as Parameters<typeof refusedForStorage>[0], sent };
}

describe("plan storage limit (GRYT-2170)", () => {
  it("has no limit unless the host sets one", async () => {
    delete process.env.GRYT_PLAN_STORAGE_BYTES;
    assert.equal(planStorageBytes(), null);
    const { res, sent } = fakeRes();
    assert.equal(await refusedForStorage(res), false);
    assert.equal(sent.status, undefined);
  });

  it("lets uploads in below the limit and refuses them once it's used", async () => {
    process.env.GRYT_PLAN_STORAGE_BYTES = String(1000);
    await insertFile({ file_id: "a", s3_key: "uploads/a", mime: "image/png", size: 600, width: null, height: null, thumbnail_key: null, original_name: "a.png", uploaded_by_server_user_id: null });
    assert.equal(await refusedForStorage(fakeRes().res), false);

    await insertFile({ file_id: "b", s3_key: "uploads/b", mime: "image/png", size: 500, width: null, height: null, thumbnail_key: null, original_name: "b.png", uploaded_by_server_user_id: null });
    const { res, sent } = fakeRes();
    assert.equal(await refusedForStorage(res), true);
    assert.equal(sent.status, 413);
    assert.equal(sent.body?.error, "storage_full");
    assert.match(sent.body?.message ?? "", /all of its .* of storage/);
  });
});
