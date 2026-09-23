import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { insertMessage, listMessages, listThreadMessages } from "./messages";
import {
  bumpThreadOnReply,
  createThread,
  decrementThreadReply,
  deleteThread,
  getThread,
  getThreadByRoot,
  listThreadsByConversation,
  listThreadsByRootMessageIds,
} from "./threads";

/** Replies live in the messages table and never come back from `listMessages`,
    which shows `thread_id IS NULL`. Break that and every reply doubles up. */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-threads-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CONV = "channel-1";

async function seedRoot(text = "root message"): Promise<string> {
  const root = await insertMessage({
    conversation_id: CONV,
    sender_server_id: "u_alice",
    text,
    attachments: null,
    reactions: null,
  });
  return root.message_id;
}

describe("threads persistence", () => {
  it("creates a thread off a root message and finds it both ways", async () => {
    const rootId = await seedRoot();
    const thread = await createThread({
      conversation_id: CONV,
      root_message_id: rootId,
      created_by: "u_alice",
      title: "Voice drops after sleep",
    });

    assert.equal(thread.status, "open");
    assert.equal(thread.reply_count, 0);
    assert.equal(thread.locked, false);
    assert.equal(thread.title, "Voice drops after sleep");

    const byId = await getThread(thread.thread_id);
    const byRoot = await getThreadByRoot(rootId);
    assert.equal(byId?.thread_id, thread.thread_id);
    assert.equal(byRoot?.thread_id, thread.thread_id);
  });

  it("keeps thread replies out of the channel timeline but returns them per-thread", async () => {
    const rootId = await seedRoot("a normal channel message");
    const thread = await createThread({
      conversation_id: CONV,
      root_message_id: rootId,
      created_by: "u_alice",
    });

    // Two replies in the same millisecond tie on created_at and fall back to
    // message_id order, which is stable but not insertion order.
    await insertMessage({
      conversation_id: CONV,
      sender_server_id: "u_bob",
      text: "reply one",
      attachments: null,
      reactions: null,
      thread_id: thread.thread_id,
      created_at: new Date(1000),
    });
    await insertMessage({
      conversation_id: CONV,
      sender_server_id: "u_alice",
      text: "reply two",
      attachments: null,
      reactions: null,
      thread_id: thread.thread_id,
      created_at: new Date(2000),
    });

    // The channel timeline shows the two roots from this test's two messages,
    // never the thread replies.
    const timeline = await listMessages(CONV, 50);
    const timelineTexts = timeline.map((m) => m.text);
    assert.ok(!timelineTexts.includes("reply one"), "reply leaked into the channel");
    assert.ok(!timelineTexts.includes("reply two"), "reply leaked into the channel");
    assert.ok(timelineTexts.includes("a normal channel message"), "root should be in the timeline");

    // The thread itself has both replies, oldest first.
    const replies = await listThreadMessages(thread.thread_id);
    assert.deepEqual(
      replies.map((m) => m.text),
      ["reply one", "reply two"],
    );
    assert.ok(replies.every((m) => m.thread_id === thread.thread_id));
  });

  it("bumps and floors the reply counter", async () => {
    const rootId = await seedRoot();
    const thread = await createThread({ conversation_id: CONV, root_message_id: rootId, created_by: "u_alice" });

    const later = new Date(thread.created_at.getTime() + 60_000);
    const bumped = await bumpThreadOnReply(thread.thread_id, later);
    assert.equal(bumped?.reply_count, 1);
    assert.equal(bumped?.last_message_at.getTime(), later.getTime());

    await bumpThreadOnReply(thread.thread_id, later);
    const afterTwo = await getThread(thread.thread_id);
    assert.equal(afterTwo?.reply_count, 2);

    await decrementThreadReply(thread.thread_id);
    await decrementThreadReply(thread.thread_id);
    await decrementThreadReply(thread.thread_id); // one past zero
    const floored = await getThread(thread.thread_id);
    assert.equal(floored?.reply_count, 0, "reply_count must never go negative");
  });

  it("deletes a thread and every reply in it, leaving the root", async () => {
    const rootId = await seedRoot("root that will keep living");
    const thread = await createThread({ conversation_id: CONV, root_message_id: rootId, created_by: "u_alice" });
    await insertMessage({
      conversation_id: CONV,
      sender_server_id: "u_bob",
      text: "doomed reply",
      attachments: null,
      reactions: null,
      thread_id: thread.thread_id,
    });

    const removed = await deleteThread(thread.thread_id);
    assert.equal(removed?.root_message_id, rootId);
    assert.equal(await getThread(thread.thread_id), null);
    assert.equal((await listThreadMessages(thread.thread_id)).length, 0);

    // The root is a normal message and is untouched by deleting the thread.
    const timeline = await listMessages(CONV, 50);
    assert.ok(timeline.some((m) => m.text === "root that will keep living"));
  });

  it("lists a conversation's threads, most-recently-active first", async () => {
    const conv = "channel-sort";
    const older = await createThread({
      conversation_id: conv,
      root_message_id: (await insertMessage({ conversation_id: conv, sender_server_id: "u_a", text: "r1", attachments: null, reactions: null })).message_id,
      created_by: "u_a",
      created_at: new Date(1000),
    });
    const newer = await createThread({
      conversation_id: conv,
      root_message_id: (await insertMessage({ conversation_id: conv, sender_server_id: "u_a", text: "r2", attachments: null, reactions: null })).message_id,
      created_by: "u_a",
      created_at: new Date(2000),
    });

    const listed = await listThreadsByConversation(conv);
    assert.deepEqual(
      listed.map((t) => t.thread_id),
      [newer.thread_id, older.thread_id],
    );
  });

  it("looks up a page of roots at once, and only in this conversation", async () => {
    const conv = "channel-page";
    const other = "channel-elsewhere";
    const rootA = (await insertMessage({ conversation_id: conv, sender_server_id: "u_a", text: "a", attachments: null, reactions: null })).message_id;
    const rootB = (await insertMessage({ conversation_id: conv, sender_server_id: "u_a", text: "b", attachments: null, reactions: null })).message_id;
    const plain = (await insertMessage({ conversation_id: conv, sender_server_id: "u_a", text: "no thread here", attachments: null, reactions: null })).message_id;
    const rootElsewhere = (await insertMessage({ conversation_id: other, sender_server_id: "u_a", text: "c", attachments: null, reactions: null })).message_id;

    const a = await createThread({ conversation_id: conv, root_message_id: rootA, created_by: "u_a", title: "A" });
    const b = await createThread({ conversation_id: conv, root_message_id: rootB, created_by: "u_a", tags: ["t1"] });
    await createThread({ conversation_id: other, root_message_id: rootElsewhere, created_by: "u_a" });
    await bumpThreadOnReply(b.thread_id, new Date(5000));

    const found = await listThreadsByRootMessageIds(conv, [rootA, rootB, plain, rootElsewhere]);
    assert.deepEqual(
      found.map((t) => t.thread_id).sort(),
      [a.thread_id, b.thread_id].sort(),
      "a root in another conversation must not come back",
    );
    const byRoot = new Map(found.map((t) => [t.root_message_id, t]));
    assert.equal(byRoot.get(rootA)?.title, "A");
    assert.equal(byRoot.get(rootB)?.reply_count, 1, "the reply count a reload has to show");
    assert.deepEqual(byRoot.get(rootB)?.tags, ["t1"]);

    assert.deepEqual(await listThreadsByRootMessageIds(conv, []), [], "an empty page runs no query");
  });
});
