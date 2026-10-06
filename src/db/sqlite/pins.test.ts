import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { countPinnedMessages, getMessageById, insertMessage, listPinnedMessages, setMessagePinned } from "./messages";

describe("pinned messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "gryt-pins-"));
  const CONV = "c1";

  before(async () => {
    process.env.DATA_DIR = dir;
    await initSqlite();
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (const id of ["a", "b", "c"]) {
      await insertMessage({ conversation_id: CONV, sender_server_id: "u1", text: id, attachments: null, reactions: null, message_id: id, created_at: new Date(base) });
    }
    await insertMessage({ conversation_id: "other", sender_server_id: "u1", text: "x", attachments: null, reactions: null, message_id: "x" });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("pins, lists newest pin first, and unpins", async () => {
    const a = await setMessagePinned(CONV, "a", "mod");
    assert.equal(a?.pinned_by, "mod");
    assert.ok(a?.pinned_at instanceof Date);
    await new Promise((r) => setTimeout(r, 5));
    await setMessagePinned(CONV, "c", "mod");
    await setMessagePinned("other", "x", "mod");

    assert.deepEqual((await listPinnedMessages(CONV)).map((m) => m.message_id), ["c", "a"]);
    assert.equal(await countPinnedMessages(CONV), 2);

    const un = await setMessagePinned(CONV, "a", null);
    assert.equal(un?.pinned_at, undefined);
    assert.equal((await getMessageById(CONV, "a"))?.pinned_by, undefined);
    assert.deepEqual((await listPinnedMessages(CONV)).map((m) => m.message_id), ["c"]);
  });

  it("returns null for a message that isn't there", async () => {
    assert.equal(await setMessagePinned(CONV, "missing", "mod"), null);
  });
});
