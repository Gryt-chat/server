import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { deleteMessage, insertMessage } from "./messages";
import {
  countUnseenMentions,
  listUnseenMentions,
  markMentionsSeen,
  recordMentions,
} from "./mentions";

/**
 * A real database, because two of the things being checked are the schema
 * rather than the code around it: the primary key that makes a re-parse
 * harmless, and the cascade that takes a mention with the message it points at.
 * Neither of those exists in a mock.
 */
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-mentions-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function message(conversationId: string, sender = "u_sender") {
  return insertMessage({
    conversation_id: conversationId,
    sender_server_id: sender,
    text: "hello @ada",
  } as Parameters<typeof insertMessage>[0]);
}

/** The message behind chan_c's mention, so the re-parse test can reuse it. */
let chanC = "";

describe("mentions", () => {
  it("stores one per person named", async () => {
    const m = await message("chan_a");
    const stored = await recordMentions({
      conversationId: "chan_a",
      messageId: m.message_id,
      senderServerUserId: "u_sender",
      serverUserIds: ["u_ada", "u_tor"],
    });

    assert.deepEqual(stored.sort(), ["u_ada", "u_tor"]);
    assert.equal((await listUnseenMentions("u_ada")).length, 1);
    assert.equal((await listUnseenMentions("u_tor")).length, 1);
  });

  it("never mentions the sender", async () => {
    const m = await message("chan_b", "u_ada");
    const stored = await recordMentions({
      conversationId: "chan_b",
      messageId: m.message_id,
      senderServerUserId: "u_ada",
      serverUserIds: ["u_ada", "u_tor"],
    });

    assert.deepEqual(stored, ["u_tor"]);
    assert.equal((await listUnseenMentions("u_ada")).length, 1); // still only chan_a
  });

  it("does not double up when the same message is parsed again", async () => {
    // What an edit does: the text is re-read and the same names come back.
    const m = await message("chan_c");
    chanC = m.message_id;
    const args = {
      conversationId: "chan_c",
      messageId: m.message_id,
      senderServerUserId: "u_sender",
      serverUserIds: ["u_tor"],
    };
    await recordMentions(args);
    await recordMentions(args);

    const counts = await countUnseenMentions("u_tor");
    assert.equal(counts.chan_c, 1);
  });

  it("does not un-read a mention that was re-parsed", async () => {
    await markMentionsSeen("u_tor", "chan_c");
    await recordMentions({
      conversationId: "chan_c",
      messageId: chanC,
      senderServerUserId: "u_sender",
      serverUserIds: ["u_tor"],
    });

    const counts = await countUnseenMentions("u_tor");
    assert.equal(counts.chan_c, undefined);
  });

  it("counts what is left per conversation", async () => {
    const counts = await countUnseenMentions("u_tor");
    assert.equal(counts.chan_a, 1);
    assert.equal(counts.chan_b, 1);
    assert.equal(counts.chan_c, undefined);
  });

  it("clears one conversation, then all of them", async () => {
    assert.equal(await markMentionsSeen("u_tor", "chan_a"), 1);
    assert.equal(Object.keys(await countUnseenMentions("u_tor")).length, 1);

    assert.equal(await markMentionsSeen("u_tor"), 1);
    assert.deepEqual(await countUnseenMentions("u_tor"), {});
  });

  it("reports nothing changed when there is nothing left to read", async () => {
    assert.equal(await markMentionsSeen("u_tor"), 0);
  });

  it("goes away with the message it points at", async () => {
    // The reason for the foreign key. A badge that survives its message
    // scrolls to a gap.
    const m = await message("chan_d");
    await recordMentions({
      conversationId: "chan_d",
      messageId: m.message_id,
      senderServerUserId: "u_sender",
      serverUserIds: ["u_mia"],
    });
    assert.equal((await listUnseenMentions("u_mia")).length, 1);

    await deleteMessage("chan_d", m.message_id);
    assert.deepEqual(await listUnseenMentions("u_mia"), []);
  });

  it("says nothing about somebody who has never been named", async () => {
    assert.deepEqual(await listUnseenMentions("u_nobody"), []);
    assert.deepEqual(await countUnseenMentions("u_nobody"), {});
  });
});
