import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "./connection";
import { deleteMessage, insertMessage, searchMessages, toFtsQuery, updateMessageText } from "./messages";
import { createThread } from "./threads";

/** GRYT-1738: full-text search over channel messages, only where the caller says. */
describe("message search", () => {
  const dir = mkdtempSync(join(tmpdir(), "gryt-search-"));
  const base = Date.UTC(2026, 9, 1, 12, 0, 0);
  let n = 0;
  const add = (conversation_id: string, text: string | null, sender = "u1", extra: Record<string, unknown> = {}) =>
    insertMessage({
      conversation_id, sender_server_id: sender, text, attachments: null, reactions: null,
      message_id: `m${++n}`, created_at: new Date(base + n * 1000), ...extra,
    });

  before(async () => {
    process.env.DATA_DIR = dir;
    await initSqlite();
    await add("general", "Skål for Gryt i kveld");
    await add("general", "who is up for deep rock tonight", "u2");
    await add("random", "deep rock is on sale");
    await add("hidden", "the deep secret plan");
    await add("general", null);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const ids = (hits: { message_id: string }[]) => hits.map((h) => h.message_id);

  it("finds words regardless of accents and case", async () => {
    const hits = await searchMessages({ query: "SKAL gryt", conversationIds: ["general"], limit: 10 });
    assert.deepEqual(ids(hits), ["m1"]);
    assert.match(hits[0].snippet, /\u0002Skål\u0003/);
  });

  it("matches the last word as a prefix", async () => {
    assert.deepEqual(ids(await searchMessages({ query: "tonig", conversationIds: ["general"], limit: 10 })), ["m2"]);
  });

  it("only searches the conversations it is given, newest first", async () => {
    assert.deepEqual(ids(await searchMessages({ query: "deep", conversationIds: ["general", "random"], limit: 10 })), ["m3", "m2"]);
    assert.deepEqual(ids(await searchMessages({ query: "deep", conversationIds: [], limit: 10 })), []);
  });

  it("filters by sender and pages with before", async () => {
    assert.deepEqual(ids(await searchMessages({ query: "deep", conversationIds: ["general", "random"], senderServerId: "u2", limit: 10 })), ["m2"]);
    const older = await searchMessages({ query: "deep", conversationIds: ["general", "random"], before: new Date(base + 3 * 1000), limit: 10 });
    assert.deepEqual(ids(older), ["m2"]);
  });

  it("follows edits and deletes", async () => {
    await updateMessageText("random", "m3", "nothing to see");
    assert.deepEqual(ids(await searchMessages({ query: "deep", conversationIds: ["random"], limit: 10 })), []);
    assert.deepEqual(ids(await searchMessages({ query: "nothing", conversationIds: ["random"], limit: 10 })), ["m3"]);
    await deleteMessage("random", "m3");
    assert.deepEqual(ids(await searchMessages({ query: "nothing", conversationIds: ["random"], limit: 10 })), []);
  });

  it("indexes messages that were there before the index existed", async () => {
    const db = getSqliteDb();
    db.exec(`DROP TABLE messages_fts; DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete; DROP TRIGGER messages_fts_update;`);
    await add("general", "written while nothing indexed");
    await initSqlite();
    assert.deepEqual(ids(await searchMessages({ query: "written", conversationIds: ["general"], limit: 10 })), [`m${n}`]);
  });

  it("gives a thread reply the message its thread hangs off", async () => {
    const root = await add("general", "thread starter");
    const thread = await createThread({ conversation_id: "general", root_message_id: root.message_id, created_by: "u1" });
    await add("general", "reply about zebras", "u1", { thread_id: thread.thread_id });
    const [hit] = await searchMessages({ query: "zebras", conversationIds: ["general"], limit: 10 });
    assert.equal(hit.thread_id, thread.thread_id);
    assert.equal(hit.thread_root_message_id, root.message_id);
    assert.equal((await searchMessages({ query: "starter", conversationIds: ["general"], limit: 10 }))[0].thread_root_message_id, null);
  });

  it("never passes search syntax through", async () => {
    assert.equal(toFtsQuery('deep OR "x" NEAR(a b) text:secret *'), '"deep" "OR" """x""" "NEAR(a" "b)" "text:secret" "*"*');
    assert.equal(toFtsQuery("   "), null);
    // Operators are plain words, so these can't error or reach another column.
    for (const q of ['"', "a AND", "NOT", "text:deep", "(", "deep*"]) {
      await searchMessages({ query: q, conversationIds: ["general"], limit: 10 });
    }
  });
});
