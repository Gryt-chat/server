import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { insertMessage } from "../../db/sqlite/messages";
import type { MessageRecord } from "../../db/interfaces";
import {
  appendCachedMessage,
  dropCachedMessage,
  getMessagesCached,
  replaceCachedMessage,
  resetMessageCache,
  sweepMessageCache,
} from "./messageCache";

/*
 * `listMessages` orders by created_at and breaks ties on message_id, which is a
 * random UUID — so two messages written in the same millisecond come back in an
 * order nothing here decides. Anything read out of the database is compared as
 * a set. Order is asserted only where this module is the one that decided it.
 */
const texts = (items: { text: string | null }[]) => items.map((m) => m.text).sort();

/**
 * The first page of a conversation, kept in memory (GRYT-936).
 *
 * This lived inside chat.ts as a bare Map that six places reached into, each
 * writing its own version of "replace this one" or "take this one out". It
 * moved because something outside chat.ts can now delete a message, and the
 * failure that matters is the one nobody would notice: a delete that updates
 * the database and forgets the cache leaves the message on the next person's
 * screen, and looks exactly like a delete that did not work.
 *
 * It is a cache, so every entry is reconstructable and no write here is allowed
 * to fail anything.
 */

let dir: string;
let seq = 0;

const message = (conversationId: string, text: string): Promise<MessageRecord> =>
  insertMessage({
    conversation_id: conversationId,
    sender_server_id: "user_someone",
    text,
    sealed: null,
    attachments: null,
    reactions: null,
    reply_to_message_id: null,
    thread_id: null,
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-message-cache-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  resetMessageCache();
  seq += 1;
});

const conversation = () => `channel-${seq}`;

describe("reading a first page", () => {
  it("comes from the database when nothing is cached", async () => {
    const c = conversation();
    await message(c, "one");
    await message(c, "two");

    assert.deepEqual(texts(await getMessagesCached(c)), ["one", "two"]);
  });

  /* The second read must not hit the database. Checked by writing a message
     behind the cache's back — if the read went to the database it would see it. */
  it("comes from memory the second time", async () => {
    const c = conversation();
    await message(c, "one");
    await getMessagesCached(c);

    await message(c, "written behind its back");

    assert.deepEqual((await getMessagesCached(c)).map((m) => m.text), ["one"]);
  });

  /* Built through `append` rather than read back from the database, because the
     order of same-millisecond rows is not this module's to promise. */
  it("takes the last N when a limit is given", async () => {
    const c = conversation();
    const one = await message(c, "one");
    for (const t of ["one", "two", "three"]) appendCachedMessage(c, { ...one, message_id: t, text: t });

    assert.deepEqual((await getMessagesCached(c, 2)).map((m) => m.text), ["two", "three"]);
  });

  it("is empty for a conversation with nothing in it", async () => {
    assert.deepEqual(await getMessagesCached(conversation()), []);
  });
});

describe("a new message", () => {
  it("lands on the end", async () => {
    const c = conversation();
    await message(c, "one");
    await getMessagesCached(c);

    appendCachedMessage(c, await message(c, "two"));

    assert.deepEqual((await getMessagesCached(c)).map((m) => m.text), ["one", "two"]);
    // Order here *is* this module's: append puts it on the end.
  });

  /* Appending to a conversation nobody has read yet is allowed. What it must
     not do is leave an entry that reads as a full first page — the next read
     past the TTL refills from the database either way. */
  it("can start an entry that did not exist", async () => {
    const c = conversation();
    appendCachedMessage(c, await message(c, "first anybody has seen"));

    assert.deepEqual((await getMessagesCached(c)).map((m) => m.text), ["first anybody has seen"]);
  });

  it("keeps the cache from growing without limit", async () => {
    const c = conversation();
    const one = await message(c, "kept");
    for (let i = 0; i < 130; i++) appendCachedMessage(c, { ...one, message_id: `m${i}` });

    const items = await getMessagesCached(c, 500);
    assert.ok(items.length <= 100, `${items.length} messages cached for one conversation`);
    assert.equal(items[items.length - 1].message_id, "m129", "it kept the oldest rather than the newest");
  });
});

describe("a message that changed", () => {
  it("is replaced in place", async () => {
    const c = conversation();
    const one = await message(c, "before");
    await getMessagesCached(c);

    replaceCachedMessage(c, { ...one, text: "after" });

    assert.deepEqual((await getMessagesCached(c)).map((m) => m.text), ["after"]);
  });

  /* Creating an entry from one message would claim a first page that is one
     message long, and the next reader would get it. */
  it("does nothing when the conversation is not cached", async () => {
    const c = conversation();
    const one = await message(c, "in the database");

    replaceCachedMessage(c, { ...one, text: "only in memory" });

    assert.deepEqual(
      (await getMessagesCached(c)).map((m) => m.text),
      ["in the database"],
      "an uncached conversation was given a page out of one edit",
    );
  });

  it("leaves the others alone", async () => {
    const c = conversation();
    const one = await message(c, "one");
    await message(c, "two");
    await getMessagesCached(c);

    replaceCachedMessage(c, { ...one, text: "one, edited" });

    assert.deepEqual(texts(await getMessagesCached(c)), ["one, edited", "two"]);
  });
});

/*
 * The one this module was extracted for. A delete that updates the database and
 * not this leaves the message on the next person's first page until the entry
 * ages out — which reads as a delete that did not work, and is exactly the bug
 * a second caller outside chat.ts would have introduced.
 */
describe("a message that is gone", () => {
  it("goes from the cache too", async () => {
    const c = conversation();
    const one = await message(c, "one");
    await message(c, "two");
    await getMessagesCached(c);

    dropCachedMessage(c, one.message_id);

    assert.deepEqual(texts(await getMessagesCached(c)), ["two"]);
  });

  it("does not disturb a conversation that was never cached", async () => {
    const c = conversation();
    await message(c, "one");

    dropCachedMessage(c, "never-existed");

    assert.deepEqual((await getMessagesCached(c)).map((m) => m.text), ["one"]);
  });

  it("is quiet about an id that is not there", async () => {
    const c = conversation();
    await message(c, "one");
    await getMessagesCached(c);

    assert.doesNotThrow(() => dropCachedMessage(c, "never-existed"));
    assert.equal((await getMessagesCached(c)).length, 1);
  });
});

/*
 * The only interesting thing about a cache is what it does at the boundary. The
 * fresh half is covered above; this is the other one, and without it "always
 * serve from memory" passes every test in this file.
 */
describe("an entry that has gone stale", () => {
  it("is re-read rather than served", async () => {
    const c = conversation();
    await message(c, "one");
    await getMessagesCached(c);
    await message(c, "written behind its back");

    const later = Date.now() + 10 * 60 * 1000;

    assert.equal((await getMessagesCached(c, 50, later)).length, 2);
  });

  it("is still served while it is fresh", async () => {
    const c = conversation();
    await message(c, "one");
    await getMessagesCached(c);
    await message(c, "written behind its back");

    assert.equal((await getMessagesCached(c, 50, Date.now())).length, 1);
  });
});

describe("sweeping", () => {
  it("leaves a fresh entry alone", async () => {
    const c = conversation();
    await message(c, "one");
    await getMessagesCached(c);
    await message(c, "written behind its back");

    sweepMessageCache();

    assert.equal((await getMessagesCached(c)).length, 1, "a fresh entry was swept");
  });

  it("drops one that is old enough, so the next read goes to the database", async () => {
    const c = conversation();
    await message(c, "one");
    await getMessagesCached(c);
    await message(c, "written behind its back");

    // Far enough ahead to clear twice the TTL, whatever it is configured to.
    sweepMessageCache(Date.now() + 10 * 60 * 1000);

    assert.equal((await getMessagesCached(c)).length, 2);
  });
});
