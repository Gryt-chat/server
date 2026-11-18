import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "./connection";
import { insertFile, insertMessage, storedFileBytes } from "./messages";
import { biggestStorageConversations, listStorageFiles, markFilesDeleted, storageFileIds } from "./storageFiles";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-storage-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  const file = (id: string, size: number, mime: string, name: string, at: string) =>
    insertFile({ file_id: id, s3_key: `uploads/${id}`, mime, size, width: null, height: null, thumbnail_key: null, original_name: name, uploaded_by_server_user_id: "u1", created_at: new Date(at) });
  await file("big", 400, "video/mp4", "finals.mp4", "2026-01-01T00:00:00Z");
  await file("mid", 90, "image/png", "shot.png", "2026-06-01T00:00:00Z");
  await file("small", 5, "application/zip", "maps.zip", "2026-10-01T00:00:00Z");
  await insertMessage({ conversation_id: "clips", sender_server_id: "u1", text: "", attachments: ["big", "mid"], reactions: null, reply_to_message_id: null });
  await insertMessage({ conversation_id: "general", sender_server_id: "u1", text: "maps", attachments: ["small"], reactions: null, reply_to_message_id: null });
  await insertMessage({ conversation_id: "general", sender_server_id: "u1", text: "again", attachments: ["big"], reactions: null, reply_to_message_id: null });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the storage list", () => {
  it("lists each file once, biggest first, with a total", () => {
    const page = listStorageFiles({});
    assert.deepEqual(page.items.map((f) => f.file_id), ["big", "mid", "small"]);
    assert.equal(page.total, 3);
    assert.equal(page.totalBytes, 495);
  });

  it("filters by channel, kind, name and age, and sorts by name", () => {
    assert.deepEqual(listStorageFiles({ conversationId: "clips" }).items.map((f) => f.file_id), ["big", "mid"]);
    assert.deepEqual(listStorageFiles({ kind: "image" }).items.map((f) => f.file_id), ["mid"]);
    assert.deepEqual(listStorageFiles({ q: "MAP" }).items.map((f) => f.file_id), ["small"]);
    assert.deepEqual(storageFileIds({ olderThan: new Date("2026-03-01T00:00:00Z") }).map((f) => f.file_id), ["big"]);
    assert.deepEqual(listStorageFiles({}, "name", "asc").items.map((f) => f.file_id), ["big", "small", "mid"]);
  });

  it("keeps a name search from matching on wildcards", () => {
    assert.equal(listStorageFiles({ q: "%" }).total, 0);
  });

  it("leaves deleted files out of the list and the totals, but keeps the row", async () => {
    markFilesDeleted(["big"]);
    assert.deepEqual(listStorageFiles({}).items.map((f) => f.file_id), ["mid", "small"]);
    assert.equal(await storedFileBytes(), 95);
    assert.deepEqual(biggestStorageConversations().map((c) => c.conversation_id), ["clips", "general"]);
    const row = getSqliteDb().prepare("SELECT deleted_at FROM files WHERE file_id = 'big'").get() as { deleted_at: string };
    assert.ok(row.deleted_at);
  });
});
