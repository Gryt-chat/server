import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { insertMessage, purgeUserContent } from "./messages";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-purge-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const post = (sender: string, attachments: string[] | null, conversation = "c1") =>
  insertMessage({
    conversation_id: conversation,
    sender_server_id: sender,
    text: "hello",
    attachments,
    reactions: null,
    reply_to_message_id: null,
  });

describe("what a purge orphans", () => {
  it("reports the files the deleted messages carried", async () => {
    await post("spammer", ["file-a", "file-b"]);
    await post("spammer", ["file-c"]);

    const { orphanedAttachmentIds, deletedMessages } = await purgeUserContent("spammer");

    assert.equal(deletedMessages.length, 2);
    assert.deepEqual([...orphanedAttachmentIds].sort(), ["file-a", "file-b", "file-c"]);
  });

  it("leaves a file alone when somebody else's message still points at it", async () => {
    // The case that makes a blind delete wrong. Nothing in Gryt attaches one
    // file to two messages today, but the purge should not be the thing that
    // assumes so.
    await post("spammer2", ["shared", "only-theirs"]);
    await post("innocent", ["shared"]);

    const { orphanedAttachmentIds } = await purgeUserContent("spammer2");

    assert.deepEqual(orphanedAttachmentIds, ["only-theirs"]);
  });

  it("says nothing was orphaned when the messages had no attachments", async () => {
    await post("quiet", null);
    const { orphanedAttachmentIds } = await purgeUserContent("quiet");
    assert.deepEqual(orphanedAttachmentIds, []);
  });

  it("survives an attachments column that will not parse", async () => {
    // A ban is not a good moment to throw. The sweep still catches the file
    // later by the ordinary orphan rule.
    const { getSqliteDb } = await import("./connection");
    await post("broken", ["fine"]);
    getSqliteDb()
      .prepare(`UPDATE messages SET attachments = ? WHERE sender_server_id = ?`)
      .run("{not json", "broken");

    const { orphanedAttachmentIds } = await purgeUserContent("broken");
    assert.deepEqual(orphanedAttachmentIds, []);
  });
});
