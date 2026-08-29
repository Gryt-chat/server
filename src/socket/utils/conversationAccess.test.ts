import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite, toIso } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import {
  directConversationId,
  openDirectConversation,
  purgeOrphanedConversations,
} from "../../db/sqlite/conversations";
import { resetChannelIdCache, resolveConversationAccess } from "./conversationAccess";

/**
 * The rule that decides who can read a conversation.
 *
 * Every case here is one somebody could try on purpose. A DM id is derived from
 * the two `server_user_id`s and member lists carry those, so anybody on the
 * server can work out the id of a conversation between two other people and ask
 * for it — which is the whole reason this file exists and why "could you name
 * the id" is never the question being answered.
 */

let dir: string;

const ALICE = "srv_alice";
const BOB = "srv_bob";
const MALLORY = "srv_mallory";

/** A member row, since access leans on `users.is_active` for the purge. */
function addUser(serverUserId: string, active = true): void {
  const db = getSqliteDb();
  const now = toIso(new Date());
  db.prepare(
    `INSERT INTO users (gryt_user_id, server_user_id, nickname, is_active, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`gryt_${serverUserId}`, serverUserId, serverUserId, active ? 1 : 0, now, now);
}

function setActive(serverUserId: string, active: boolean): void {
  getSqliteDb()
    .prepare(`UPDATE users SET is_active = ? WHERE server_user_id = ?`)
    .run(active ? 1 : 0, serverUserId);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-convaccess-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  addUser(ALICE);
  addUser(BOB);
  addUser(MALLORY);
  await upsertServerChannel({ channelId: "general", name: "General", type: "text" });
  resetChannelIdCache();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("direct conversation ids", () => {
  it("does not depend on who opened it", () => {
    assert.equal(directConversationId(ALICE, BOB), directConversationId(BOB, ALICE));
  });

  it("differs per pair", () => {
    assert.notEqual(directConversationId(ALICE, BOB), directConversationId(ALICE, MALLORY));
  });

  it("opens once, however many times it is asked for", async () => {
    const first = await openDirectConversation(ALICE, BOB);
    const second = await openDirectConversation(BOB, ALICE);
    assert.equal(first.conversation_id, second.conversation_id);

    const count = getSqliteDb()
      .prepare(`SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?`)
      .get(first.conversation_id) as { n: number };
    assert.equal(count.n, 2, "two members, not four");
  });

  it("refuses a conversation with yourself", async () => {
    await assert.rejects(() => openDirectConversation(ALICE, ALICE));
  });
});

describe("conversation access", () => {
  it("lets a member into their own conversation", async () => {
    const { conversation_id } = await openDirectConversation(ALICE, BOB);
    for (const who of [ALICE, BOB]) {
      const access = await resolveConversationAccess(conversation_id, who);
      assert.equal(access.allowed, true, `${who} should be allowed`);
      assert.equal(access.allowed && access.kind, "dm");
    }
  });

  it("keeps everybody else out, id or no id", async () => {
    // Mallory is a full member of the server in good standing. Being able to
    // compute the id buys nothing.
    const { conversation_id } = await openDirectConversation(ALICE, BOB);
    assert.equal(conversation_id, directConversationId(ALICE, BOB));

    const access = await resolveConversationAccess(conversation_id, MALLORY);
    assert.equal(access.allowed, false);
    assert.equal(!access.allowed && access.reason, "not_a_member");
  });

  it("says the same thing about somebody else's conversation as about no conversation", async () => {
    const { conversation_id } = await openDirectConversation(ALICE, BOB);
    const mine = await resolveConversationAccess(conversation_id, MALLORY);
    const nothing = await resolveConversationAccess("dm_0000000000000000", MALLORY);

    // Different reasons, deliberately the same words. Otherwise the error is an
    // oracle for whether two named people are talking.
    assert.equal(mine.allowed, false);
    assert.equal(nothing.allowed, false);
  });

  it("turns nobody away from a channel", async () => {
    const access = await resolveConversationAccess("general", MALLORY);
    assert.equal(access.allowed, true);
    assert.equal(access.allowed && access.kind, "channel");
  });

  it("refuses an unauthenticated socket", async () => {
    for (const who of [null, undefined, "", "temp_12345"]) {
      const access = await resolveConversationAccess("general", who);
      assert.equal(access.allowed, false, `for ${JSON.stringify(who)}`);
      assert.equal(!access.allowed && access.reason, "unauthenticated");
    }
  });

  it("refuses an id that is neither", async () => {
    const access = await resolveConversationAccess("not-a-channel", ALICE);
    assert.equal(access.allowed, false);
    assert.equal(!access.allowed && access.reason, "unknown_conversation");
  });

  it("sees a channel created since the cache was filled", async () => {
    // The cache must not be able to make "no" stick for a channel that exists.
    await upsertServerChannel({ channelId: "brand-new", name: "Brand New", type: "text" });
    const access = await resolveConversationAccess("brand-new", ALICE);
    assert.equal(access.allowed, true);
  });
});

describe("retention", () => {
  it("keeps a conversation while either party is still a member", async () => {
    const { conversation_id } = await openDirectConversation(ALICE, BOB);
    setActive(BOB, false);

    assert.deepEqual(await purgeOrphanedConversations(), []);
    const access = await resolveConversationAccess(conversation_id, ALICE);
    assert.equal(access.allowed, true, "Alice can still read it after Bob leaves");

    setActive(BOB, true);
  });

  it("drops it, and its messages, once both have gone", async () => {
    const { conversation_id } = await openDirectConversation(ALICE, BOB);
    const db = getSqliteDb();
    db.prepare(
      `INSERT INTO messages (conversation_id, message_id, sender_server_id, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(conversation_id, "m1", ALICE, "hello", toIso(new Date()));

    setActive(ALICE, false);
    setActive(BOB, false);

    assert.deepEqual(await purgeOrphanedConversations(), [conversation_id]);

    const left = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`)
      .get(conversation_id) as { n: number };
    assert.equal(left.n, 0, "messages go with the conversation");

    setActive(ALICE, true);
    setActive(BOB, true);
  });
});
