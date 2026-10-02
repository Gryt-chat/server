import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createServerConfigIfNotExists, getFile, getMessageById, updateServerConfig } from "../../db";
import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { initStorage } from "../../storage";
import { importedId } from "./ids";
import { importDiscordExport } from "./importer";
import { uploadPathMedia } from "./media";

/** The real store, through the upload path and filesystem storage, so the files rows and jobs are what uploads make. */
const FIXTURE = join(__dirname, "testdata", "dce-export");
let dataDir: string;
let root: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "gryt-dce-media-"));
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_BACKEND = "filesystem";
  delete process.env.S3_BUCKET;
  initStorage();
  await initSqlite();
  await createServerConfigIfNotExists();
  root = join(dataDir, "imports", "guild");
  cpSync(FIXTURE, root, { recursive: true });
  await importDiscordExport({ root, startedBy: "user_owner", media: uploadPathMedia });
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("imported media", () => {
  it("stores a picture the way an upload is stored, and queues its thumbnail", async () => {
    const m = await getMessageById(importedId("channel", "100"), importedId("message", "1001"));
    const [picture, notes] = m!.attachments!;
    const file = await getFile(picture);
    assert.equal(file?.mime, "image/png");
    assert.equal(file?.width, null, "dimensions stay untrusted until worker processing");
    assert.ok(file?.s3_key.startsWith("quarantine/"));
    assert.equal(file?.original_name, "cat.png");
    const owner = getSqliteDb().prepare(`SELECT uploaded_by_server_user_id AS by FROM files WHERE file_id = ?`).get(picture) as { by: string };
    assert.equal(owner.by, "discord:11");
    const jobs = getSqliteDb().prepare(`SELECT COUNT(*) AS n FROM image_jobs WHERE file_id = ?`).get(picture) as { n: number };
    assert.equal(jobs.n, 1);

    const text = await getFile(notes);
    assert.equal(text?.mime, "text/plain");
    const none = getSqliteDb().prepare(`SELECT COUNT(*) AS n FROM image_jobs WHERE file_id = ?`).get(notes) as { n: number };
    assert.equal(none.n, 0);
  });

  it("queues custom emoji through the emoji queue", () => {
    const rows = getSqliteDb().prepare(`SELECT name, uploaded_by_server_user_id AS by FROM emoji_jobs`).all() as { name: string; by: string }[];
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: "pepe", by: "user_owner" }]);
  });

  it("stores nothing twice", async () => {
    const count = () => (getSqliteDb().prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    const before = count();
    const again = await importDiscordExport({ root, startedBy: "user_owner", media: uploadPathMedia });
    assert.equal(count(), before);
    assert.equal(again.progress.files_stored, 0);
    assert.equal(again.progress.emojis_queued, 0);
  });

  it("holds imports to the server's upload limit", async () => {
    await updateServerConfig({ uploadMaxBytes: 10 });
    const outcome = await uploadPathMedia.storeFile({
      fileId: importedId("file", "limit-test"),
      path: join(root, "media", "cat-7E8F9.png"),
      originalName: "cat.png",
      uploadedBy: "discord:11",
    });
    assert.equal(outcome.kind, "skipped");
  });

  it("refuses a non-picture where only a picture fits", async () => {
    const outcome = await uploadPathMedia.storeFile({
      fileId: importedId("avatar", "not-a-picture"),
      path: join(root, "media", "notes-44444.txt"),
      originalName: "notes.txt",
      uploadedBy: "discord:11",
      imageOnly: true,
    });
    assert.deepEqual(outcome, { kind: "skipped", reason: "not a picture" });
  });
});
