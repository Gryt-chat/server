import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "./connection";
import {
  createDiscordImport,
  DISCORD_IMPORT_MAX_WARNINGS,
  ensureImportedThread,
  getDiscordImport,
  importedMessageExists,
  insertImportedMessages,
  listUnfinishedDiscordImports,
  refreshImportedThreadCounters,
  updateDiscordImport,
  type ImportedMessageRow,
} from "./discordImports";
import { getMessageById, listMessages, listThreadMessages } from "./messages";
import { getThread } from "./threads";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-import-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(id: string, patch: Partial<ImportedMessageRow> = {}): ImportedMessageRow {
  return {
    conversation_id: "chan-a",
    message_id: id,
    sender_server_id: "discord:111",
    sender_display_name: "Ola",
    sender_avatar_file_id: null,
    text: `message ${id}`,
    attachments: [],
    reactions: [],
    cards: [],
    reply_to_message_id: null,
    thread_id: null,
    created_at: new Date("2021-03-04T05:06:07.000Z"),
    edited_at: null,
    media_file_ids: [],
    ...patch,
  };
}

describe("discord import rows", () => {
  it("writes a message with its original times and the author it was posted as", () => {
    const edited = new Date("2021-03-05T00:00:00.000Z");
    assert.equal(insertImportedMessages([row("m1", { edited_at: edited })]), 1);
    const stored = getSqliteDb()
      .prepare(`SELECT * FROM messages WHERE message_id = 'm1'`)
      .get() as Record<string, unknown>;
    assert.equal(stored.created_at, "2021-03-04T05:06:07.000Z");
    assert.equal(stored.edited_at, "2021-03-05T00:00:00.000Z");
    assert.equal(stored.sender_server_id, "discord:111");
    assert.equal(stored.sender_display_name, "Ola");
  });

  it("adds nothing on a second run over the same rows", () => {
    assert.equal(insertImportedMessages([row("m1"), row("m2")]), 1);
    assert.equal(insertImportedMessages([row("m1"), row("m2")]), 0);
    const count = getSqliteDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'chan-a'`)
      .get() as { n: number };
    assert.equal(count.n, 2);
  });

  it("does not overwrite a row a rerun names again", async () => {
    insertImportedMessages([row("m1", { text: "changed on the second run" })]);
    assert.equal((await getMessageById("chan-a", "m1"))?.text, "message m1");
  });

  it("references attachments and media once each, and only for new rows", () => {
    insertImportedMessages([row("m3", { attachments: ["f1", "f2"], media_file_ids: ["avatar1", "f1"] })]);
    const refs = getSqliteDb()
      .prepare(`SELECT file_id FROM message_attachments WHERE message_id = 'm3' ORDER BY file_id`)
      .all() as { file_id: string }[];
    assert.deepEqual(refs.map((r) => r.file_id), ["avatar1", "f1", "f2"]);
  });

  it("fails loudly on a broken row instead of dropping it", () => {
    const broken = row("m-broken", { sender_server_id: null as unknown as string });
    assert.throws(() => insertImportedMessages([broken]), /NOT NULL/);
  });

  it("rolls the whole batch back when one row fails", () => {
    const bad = row("m-bad", { conversation_id: null as unknown as string });
    assert.throws(() => insertImportedMessages([row("m-rolled-back"), bad]));
    assert.equal(importedMessageExists("chan-a", "m-rolled-back"), false);
  });
});

describe("discord import threads", () => {
  it("keeps replies out of the timeline and counts them from the rows", async () => {
    insertImportedMessages([row("root")]);
    const threadId = ensureImportedThread({
      thread_id: "t1",
      conversation_id: "chan-a",
      root_message_id: "root",
      title: "A thread",
      created_by: "discord:111",
      created_at: new Date("2021-03-04T05:06:07.000Z"),
    });
    assert.equal(threadId, "t1");

    const replies = [
      row("r1", { thread_id: "t1", created_at: new Date("2021-03-06T00:00:00.000Z") }),
      row("r2", { thread_id: "t1", created_at: new Date("2021-03-07T00:00:00.000Z") }),
    ];
    insertImportedMessages(replies);
    refreshImportedThreadCounters("t1");
    insertImportedMessages(replies);
    refreshImportedThreadCounters("t1");

    const thread = await getThread("t1");
    assert.equal(thread?.reply_count, 2);
    assert.equal(thread?.last_message_at.toISOString(), "2021-03-07T00:00:00.000Z");
    assert.equal((await listThreadMessages("t1")).length, 2);
    assert.ok(!(await listMessages("chan-a")).some((m) => m.thread_id));
  });

  it("returns the thread already on a root instead of making a second", () => {
    const threadId = ensureImportedThread({
      thread_id: "t-other",
      conversation_id: "chan-a",
      root_message_id: "root",
      title: null,
      created_by: "discord:111",
      created_at: new Date(),
    });
    assert.equal(threadId, "t1");
  });
});

describe("discord import runs", () => {
  it("tracks status and progress, and lists what is unfinished", async () => {
    await createDiscordImport({ import_id: "run1", folder: "export", started_by_server_user_id: "user_owner" });
    await updateDiscordImport("run1", { status: "running" });
    assert.deepEqual((await listUnfinishedDiscordImports()).map((r) => r.import_id), ["run1"]);

    await updateDiscordImport("run1", {
      status: "done",
      progress: {
        channels_total: 1, channels_done: 1, messages_imported: 3, messages_already_there: 0,
        messages_skipped: 0, files_stored: 0, files_already_there: 0, files_skipped: 0,
        files_missing: 0, emojis_queued: 0,
      },
    });
    const run = await getDiscordImport("run1");
    assert.equal(run?.status, "done");
    assert.equal(run?.progress?.messages_imported, 3);
    assert.ok(run?.finished_at);
    assert.equal((await listUnfinishedDiscordImports()).length, 0);
  });

  it("caps the warnings it keeps", async () => {
    await createDiscordImport({ import_id: "run2", folder: "export", started_by_server_user_id: "user_owner" });
    await updateDiscordImport("run2", { warnings: Array.from({ length: 500 }, (_, i) => `w${i}`) });
    assert.equal((await getDiscordImport("run2"))?.warnings.length, DISCORD_IMPORT_MAX_WARNINGS);
  });
});
