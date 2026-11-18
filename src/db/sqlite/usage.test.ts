import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { insertFile, insertMessage } from "./messages";
import { upsertUser } from "./users";
import { usageNumbers } from "./usage";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-usage-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const file = (id: string, key: string, size: number) =>
  insertFile({ file_id: id, s3_key: key, mime: "image/png", size, width: null, height: null, thumbnail_key: null, original_name: id, uploaded_by_server_user_id: null });

describe("usage numbers (GRYT-2147)", () => {
  it("adds up storage by kind, members and messages per day", async () => {
    await file("a", "uploads/a.png", 700);
    await file("b", "uploads/b.png", 300);
    await file("c", "avatars/c.avif", 50);
    await upsertUser("key:one", "One");
    await upsertUser("key:two", "Two");
    await insertMessage({ conversation_id: "general", sender_server_id: "x", text: "hi", attachments: null, reactions: null });
    await insertMessage({ conversation_id: "general", sender_server_id: "x", text: "again", attachments: null, reactions: null });

    const usage = usageNumbers();
    assert.deepEqual(usage.storageBytes, { total: 1050, byKind: { uploads: 1000, avatars: 50 } });
    assert.equal(usage.members.total, 2);
    assert.equal(usage.members.active30d, 2);
    assert.equal(usage.messagesPerDay.length, 1);
    assert.equal(usage.messagesPerDay[0].count, 2);
    assert.match(usage.messagesPerDay[0].day, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("leaves out messages older than 30 days", () => {
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    assert.deepEqual(usageNumbers(later).messagesPerDay, []);
  });
});
