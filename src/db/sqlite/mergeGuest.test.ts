import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { eitherHasBlocked, blockUser, listBlocks } from "./blocks";
import { getSqliteDb, initSqlite } from "./connection";
import { createGroupConversation, listConversationMemberIds, openDirectConversation } from "./conversations";
import { recordMentions } from "./mentions";
import { AUTHOR_COLUMNS, mergeGuestIntoAccount } from "./mergeGuest";
import { addReactionToMessage, getFileOwnership, getMessageById, insertFile, insertMessage } from "./messages";
import {
  addMemberRole,
  claimServerOwner,
  createServerConfigIfNotExists,
  getServerConfig,
  listMemberRoles,
  setServerOwner,
  setServerRole,
} from "./servers";
import { createThread, getThread } from "./threads";
import { createRefreshToken, getRefreshToken } from "./tokens";
import { carryIdentityForward, getUserByGrytId, setUserAvatar, setUserModerationState, upsertUser } from "./users";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-merge-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

function send(conversationId: string, sender: string, body: { text?: string; attachments?: string[] }) {
  return insertMessage({
    conversation_id: conversationId, sender_server_id: sender,
    text: body.text ?? null, attachments: body.attachments ?? null, reactions: null,
  });
}

async function pair(tag: string) {
  const guest = await upsertUser(`key:${tag}`, `Guest ${tag}`);
  const account = await upsertUser(`account-${tag}`, `Account ${tag}`);
  return { guest, account, guestId: `key:${tag}`, accountId: `account-${tag}` };
}

describe("merging a guest into an account that is already a member", () => {
  it("moves the guest's messages and keeps the account's name, picture and roles", async () => {
    const { guest, account, guestId, accountId } = await pair("msg");
    await setUserAvatar(guest.server_user_id, "file-guest-avatar");
    await setUserAvatar(account.server_user_id, "file-account-avatar");
    await setServerRole(guest.server_user_id, "admin");
    await setServerRole(account.server_user_id, "member");
    const sent = await send("general", guest.server_user_id, { text: "hello" });

    const merge = mergeGuestIntoAccount(guestId, accountId);

    assert.ok(merge);
    assert.equal((await getMessageById("general", sent.message_id))?.sender_server_id, account.server_user_id);
    assert.equal(await getUserByGrytId(guestId), null, "the guest's row is gone");
    const now = await getUserByGrytId(accountId);
    assert.equal(now?.nickname, "Account msg");
    assert.equal(now?.avatar_file_id, "file-account-avatar");
    assert.deepEqual(await listMemberRoles(account.server_user_id), ["member"], "the guest's admin role does not come along");
    assert.deepEqual(await listMemberRoles(guest.server_user_id), [], "and is not left dangling");
  });

  it("keeps one reaction when both reacted to the same message with the same emoji", async () => {
    const { guest, account, guestId, accountId } = await pair("react");
    const other = await upsertUser("account-react-other", "Other");
    const msg = await send("general", other.server_user_id, { text: "vote" });
    await addReactionToMessage("general", msg.message_id, "👍", guest.server_user_id);
    await addReactionToMessage("general", msg.message_id, "👍", other.server_user_id);
    await addReactionToMessage("general", msg.message_id, "👍", account.server_user_id);
    await addReactionToMessage("general", msg.message_id, "🎉", guest.server_user_id);

    mergeGuestIntoAccount(guestId, accountId);

    const reactions = (await getMessageById("general", msg.message_id))?.reactions ?? [];
    const thumbs = reactions.find((r) => r.src === "👍");
    const party = reactions.find((r) => r.src === "🎉");
    assert.deepEqual(thumbs?.users, [account.server_user_id, other.server_user_id]);
    assert.equal(thumbs?.amount, 2);
    assert.deepEqual(party?.users, [account.server_user_id]);
    assert.equal(party?.amount, 1);
  });

  it("moves attachment ownership, so the account can still read what the guest uploaded", async () => {
    const { guest, account, guestId, accountId } = await pair("file");
    await insertFile({
      file_id: "file-upload-1", s3_key: "uploads/1", mime: "image/png", size: 10, width: 1, height: 1,
      thumbnail_key: null, original_name: "a.png", uploaded_by_server_user_id: guest.server_user_id,
    });
    await send("general", guest.server_user_id, { attachments: ["file-upload-1"] });

    mergeGuestIntoAccount(guestId, accountId);

    const owner = await getFileOwnership("file-upload-1");
    assert.equal(owner?.uploadedBy, account.server_user_id);
    assert.deepEqual(owner?.attachedTo, ["general"]);
  });

  it("moves ownership when the guest owns the server", async () => {
    const { guest, account, guestId, accountId } = await pair("owner");
    const db = getSqliteDb();
    db.prepare(`UPDATE server_config SET owner_gryt_user_id = NULL`).run();
    await claimServerOwner(guestId);
    await setServerRole(guest.server_user_id, "owner");
    await setServerRole(account.server_user_id, "moderator");

    const merge = mergeGuestIntoAccount(guestId, accountId);

    assert.equal(merge?.ownerMoved, true);
    assert.equal((await getServerConfig())?.owner_gryt_user_id, accountId);
    const roles = await listMemberRoles(account.server_user_id);
    assert.ok(roles.includes("owner"), `the account holds the owner role, got ${roles.join(",")}`);
    assert.ok(roles.includes("moderator"), "and keeps the roles it had");
  });

  it("leaves ownership alone when the account already owns the server", async () => {
    const { guest, account, guestId, accountId } = await pair("already-owner");
    await setServerOwner(accountId);
    await addMemberRole(account.server_user_id, "owner");
    await setServerRole(guest.server_user_id, "member");

    const merge = mergeGuestIntoAccount(guestId, accountId);

    assert.equal(merge?.ownerMoved, false);
    assert.equal((await getServerConfig())?.owner_gryt_user_id, accountId);
  });

  it("refuses a second claim cleanly, and changes nothing", async () => {
    const { guest, account, guestId, accountId } = await pair("twice");
    const sent = await send("general", guest.server_user_id, { text: "once" });

    assert.equal((await carryIdentityForward(guestId, accountId)).status, "merged");
    assert.equal(mergeGuestIntoAccount(guestId, accountId), null);
    assert.deepEqual(await carryIdentityForward(guestId, accountId), { status: "no_prior_membership" });
    assert.equal((await getMessageById("general", sent.message_id))?.sender_server_id, account.server_user_id);
    assert.equal((await getUserByGrytId(accountId))?.server_user_id, account.server_user_id);
  });

  it("moves conversations, thread authorship and mentions, keeping one row where both had one", async () => {
    const { guest, account, guestId, accountId } = await pair("convo");
    const friend = await upsertUser("account-convo-friend", "Friend");
    const third = await upsertUser("account-convo-third", "Third");
    const dm = await openDirectConversation(guest.server_user_id, friend.server_user_id);
    const group = await createGroupConversation(friend.server_user_id, [guest.server_user_id, account.server_user_id, third.server_user_id]);
    const root = await send("forum", guest.server_user_id, { text: "topic" });
    const thread = await createThread({ conversation_id: "forum", root_message_id: root.message_id, created_by: guest.server_user_id });
    const ping = await send("general", friend.server_user_id, { text: "@both" });
    await recordMentions({
      conversationId: "general", messageId: ping.message_id, senderServerUserId: friend.server_user_id,
      serverUserIds: [guest.server_user_id, account.server_user_id],
    });

    const merge = mergeGuestIntoAccount(guestId, accountId);

    assert.deepEqual([...(merge?.conversationIds ?? [])].sort(), [dm.conversation_id, group.conversation_id].sort());
    assert.deepEqual((await listConversationMemberIds(dm.conversation_id)).sort(), [account.server_user_id, friend.server_user_id].sort());
    const groupMembers = await listConversationMemberIds(group.conversation_id);
    assert.equal(groupMembers.filter((id) => id === account.server_user_id).length, 1);
    assert.ok(!groupMembers.includes(guest.server_user_id));
    assert.equal((await getThread(thread.thread_id))?.created_by, account.server_user_id);
    const mentions = getSqliteDb()
      .prepare(`SELECT server_user_id FROM mentions WHERE message_id = ?`)
      .all(ping.message_id) as { server_user_id: string }[];
    assert.deepEqual(mentions.map((m) => m.server_user_id), [account.server_user_id]);
  });

  it("carries blocks both ways, revokes the guest's sessions and keeps the stricter mute", async () => {
    const { guest, guestId, accountId } = await pair("safety");
    await upsertUser("account-safety-pest", "Pest");
    await blockUser(guestId, "account-safety-pest");
    await blockUser("account-safety-pest", guestId);
    await blockUser(accountId, guestId);
    const token = await createRefreshToken({ grytUserId: guestId, serverUserId: guest.server_user_id });
    const until = new Date(Date.now() + 60 * 60_000);
    await setUserModerationState(guest.server_user_id, { muted: true, mutedUntil: until });

    mergeGuestIntoAccount(guestId, accountId);

    assert.equal(await eitherHasBlocked(accountId, "account-safety-pest"), true);
    assert.deepEqual((await listBlocks("account-safety-pest")).map((b) => b.grytUserId), [accountId]);
    assert.deepEqual((await listBlocks(accountId)).map((b) => b.grytUserId), ["account-safety-pest"], "no block on yourself");
    assert.equal((await getRefreshToken(token.token_id))?.revoked, true);
    const now = await getUserByGrytId(accountId);
    assert.equal(now?.is_server_muted, true);
    assert.equal(now?.server_mute_expires_at?.toISOString(), until.toISOString());
  });

  it("changes nothing when any step fails", async () => {
    const { guest, guestId, accountId } = await pair("rollback");
    const sent = await send("general", guest.server_user_id, { text: "stay" });
    const db = getSqliteDb();
    db.exec(`CREATE TEMP TRIGGER refuse_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    try {
      assert.throws(() => mergeGuestIntoAccount(guestId, accountId), /refused/);
    } finally {
      db.exec(`DROP TRIGGER refuse_delete`);
    }

    assert.equal((await getMessageById("general", sent.message_id))?.sender_server_id, guest.server_user_id);
    assert.equal((await getUserByGrytId(guestId))?.server_user_id, guest.server_user_id);
  });

  it("accounts for every column that can hold a server user id", () => {
    const db = getSqliteDb();
    // Keyed on the pair or on the row itself, and handled one by one in the merge.
    const handledApart = new Set([
      "users.server_user_id", "roles.server_user_id", "conversation_members.server_user_id",
      "mentions.server_user_id", "refresh_tokens.server_user_id",
    ]);
    const listed = new Set(AUTHOR_COLUMNS.map(([t, c]) => `${t}.${c}`));
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    const missing: string[] = [];
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      for (const column of columns) {
        if (!/server_user_id|sender_server_id|created_by/.test(column.name)) continue;
        const key = `${name}.${column.name}`;
        if (!listed.has(key) && !handledApart.has(key)) missing.push(key);
      }
    }
    assert.deepEqual(missing, [], "add these to AUTHOR_COLUMNS, or handle them in mergeGuestIntoAccount");
  });
});
