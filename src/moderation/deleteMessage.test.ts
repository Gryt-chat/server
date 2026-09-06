import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { getMessageById, insertMessage } from "../db/sqlite/messages";
import type { MessageRecord } from "../db/interfaces";
import { resetMessageCache } from "../socket/utils/messageCache";
import type { Clients } from "../types";
import { deleteMessageEverywhere } from "./deleteMessage";

/**
 * The five things a delete has to do, minus the one it deliberately does not
 * (GRYT-936).
 *
 * This module exists because a member with `manage_messages` and a plugin both
 * delete messages, and two copies of a five-step operation drift. What is
 * checked here is the two steps that would go quietly missing in a second copy:
 * the attachment bytes, where the failure is a deleted image still being served
 * to anybody holding the link, and the guard that stops everything else running
 * when the row did not actually go.
 */

let dir: string;
let seq = 0;

const io = { sockets: { sockets: new Map() } } as never;
const clientsInfo: Clients = {};

const base = {
  io,
  clientsInfo,
  sfuClient: null,
  access: { allowed: true, kind: "channel" } as const,
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-delete-message-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  resetMessageCache();
  seq += 1;
});

const post = (attachments: string[] | null = null): Promise<MessageRecord> =>
  insertMessage({
    conversation_id: `channel-${seq}`,
    sender_server_id: "user_someone",
    text: "hello",
    sealed: null,
    attachments,
    reactions: null,
    reply_to_message_id: null,
    thread_id: null,
  });

describe("an ordinary delete", () => {
  it("takes the row", async () => {
    const message = await post();

    const ok = await deleteMessageEverywhere({
      ...base,
      conversationId: message.conversation_id,
      messageId: message.message_id,
      message,
    });

    assert.equal(ok, true);
    assert.equal(await getMessageById(message.conversation_id, message.message_id), null);
  });
});

/*
 * The media sweep's grace period runs from upload, so a picture posted and
 * deleted a minute later would otherwise sit in storage for the best part of an
 * hour, reachable by URL. This is the step a second copy of the delete would
 * have left out, and nothing about the message being gone would have looked
 * wrong.
 */
describe("the bytes behind it", () => {
  it("are cleaned up", async () => {
    const message = await post(["file-a", "file-b"]);
    const cleaned: string[][] = [];

    await deleteMessageEverywhere({
      ...base,
      conversationId: message.conversation_id,
      messageId: message.message_id,
      message,
      cleanUpAttachments: async (ids) => void cleaned.push(ids),
    });

    assert.deepEqual(cleaned, [["file-a", "file-b"]]);
  });

  it("are not asked about when there are none", async () => {
    const message = await post(null);
    let called = false;

    await deleteMessageEverywhere({
      ...base,
      conversationId: message.conversation_id,
      messageId: message.message_id,
      message,
      cleanUpAttachments: async () => void (called = true),
    });

    assert.equal(called, false);
  });

  /* Not awaited, and its failure is swallowed: a storage backend having a bad
     minute must not turn a successful delete into a failure. What is left
     behind is orphaned, so the sweep still collects it later. */
  it("do not fail the delete when the cleanup does", async () => {
    const message = await post(["file-a"]);

    const ok = await deleteMessageEverywhere({
      ...base,
      conversationId: message.conversation_id,
      messageId: message.message_id,
      message,
      cleanUpAttachments: async () => {
        throw new Error("storage is having a bad minute");
      },
    });

    assert.equal(ok, true);
    assert.equal(await getMessageById(message.conversation_id, message.message_id), null);
    // Let the rejection settle, so it fails this test rather than a later one.
    await new Promise((r) => setImmediate(r));
  });
});

/*
 * Telling everybody a message is gone when it is not is worse than the failure
 * that stopped it going.
 */
describe("a row that did not go", () => {
  it("stops everything else", async () => {
    const message = await post(["file-a"]);
    await deleteMessageEverywhere({
      ...base,
      conversationId: message.conversation_id,
      messageId: message.message_id,
      message,
    });

    // Second time round the row is already gone.
    let cleanedAgain = false;
    const ok = await deleteMessageEverywhere({
      ...base,
      conversationId: message.conversation_id,
      messageId: message.message_id,
      message,
      cleanUpAttachments: async () => void (cleanedAgain = true),
    });

    assert.equal(ok, false);
    assert.equal(cleanedAgain, false, "it cleaned up attachments for a delete that did not happen");
  });
});
