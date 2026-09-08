import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { insertMessage, listThreadMessages } from "./messages";

/**
 * Ascending with a limit takes the oldest rows, so a thread past its limit hid
 * the new replies with no cursor to fetch them back. The first assertion is it.
 */
describe("listThreadMessages", () => {
  const dir = mkdtempSync(join(tmpdir(), "gryt-thread-page-"));
  const THREAD = "t1";
  const CONV = "c1";

  before(async () => {
    process.env.DATA_DIR = dir;
    await initSqlite();

    // Twenty-five replies, a second apart so the order is unambiguous.
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (let i = 0; i < 25; i++) {
      await insertMessage({
        conversation_id: CONV,
        sender_server_id: "u1",
        text: `reply ${i}`,
        attachments: null,
        reactions: null,
        thread_id: THREAD,
        message_id: `m${String(i).padStart(2, "0")}`,
        created_at: new Date(base + i * 1000),
      });
    }
    // One message in the same conversation that is not in the thread, so a
    // query that forgot its where clause would be caught.
    await insertMessage({
      conversation_id: CONV,
      sender_server_id: "u1",
      text: "not in the thread",
      attachments: null,
      reactions: null,
      message_id: "channel-1",
      created_at: new Date(base + 99 * 1000),
    });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives the newest page, not the oldest", async () => {
    const page = await listThreadMessages(THREAD, 10);
    assert.equal(page.length, 10);
    // The last reply posted is the one that has to be on screen.
    assert.equal(page[page.length - 1]?.text, "reply 24");
    assert.equal(page[0]?.text, "reply 15");
  });

  it("returns a page oldest-first, so it can be rendered as it stands", async () => {
    const page = await listThreadMessages(THREAD, 5);
    assert.deepEqual(
      page.map((m) => m.text),
      ["reply 20", "reply 21", "reply 22", "reply 23", "reply 24"],
    );
  });

  it("walks backwards from a cursor without repeating or skipping", async () => {
    const first = await listThreadMessages(THREAD, 10);
    const older = await listThreadMessages(THREAD, 10, first[0]!.created_at);

    assert.equal(older.length, 10);
    assert.equal(older[older.length - 1]?.text, "reply 14");
    assert.equal(older[0]?.text, "reply 5");

    const seen = new Set([...first, ...older].map((m) => m.message_id));
    assert.equal(seen.size, 20, "a message came back on two pages");
  });

  it("runs out rather than looping at the start of the thread", async () => {
    const oldest = await listThreadMessages(THREAD, 10, new Date(Date.UTC(2026, 0, 1, 12, 0, 3)));
    assert.deepEqual(
      oldest.map((m) => m.text),
      ["reply 0", "reply 1", "reply 2"],
    );
    const none = await listThreadMessages(THREAD, 10, oldest[0]!.created_at);
    assert.equal(none.length, 0);
  });

  it("does not reach outside the thread", async () => {
    const all = await listThreadMessages(THREAD, 100);
    assert.equal(all.length, 25);
    assert.ok(!all.some((m) => m.text === "not in the thread"));
  });
});
