import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "../db/sqlite/connection";
import { upsertServerChannel } from "../db/sqlite/channels";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../db/sqlite/channelScopes";
import { createGroupConversation, leaveConversation, openDirectConversation, setConversationIcon } from "../db/sqlite/conversations";
import { deleteMessage, insertFile, insertMessage } from "../db/sqlite/messages";
import { insertReport } from "../db/sqlite/reports";
import { createRoleDefinition } from "../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { setUserAvatar, upsertUser } from "../db/sqlite/users";
import { createWebhook } from "../db/sqlite/webhooks";
import { resetChannelIdCache } from "../socket/utils/conversationAccess";
import { resetChannelPermissionCache } from "./channelPermissions";
import { fileReadVerdict, resetFileAccessCache } from "./fileAccess";

/**
 * A file token says somebody is a member. It never said which files: GRYT-921
 * was a member reading a private channel's attachment by naming its id.
 */

let dir: string;

const OPEN = "open-chan";
const PRIVATE = "staff-chan";

let alice = "";
let bob = "";
let mallory = "";
let staff = "";
let mod = "";

async function newFile(uploader: string | null = null): Promise<string> {
  const fileId = randomUUID();
  await insertFile({
    file_id: fileId,
    s3_key: `uploads/${fileId}.png`,
    mime: "image/png",
    size: 1,
    width: 1,
    height: 1,
    thumbnail_key: null,
    original_name: "x.png",
    uploaded_by_server_user_id: uploader,
  });
  return fileId;
}

async function send(conversationId: string, sender: string, fileId: string) {
  return insertMessage({
    conversation_id: conversationId,
    sender_server_id: sender,
    text: null,
    attachments: [fileId],
    reactions: null,
    reply_to_message_id: null,
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-fileaccess-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await createRoleDefinition("regular", { name: "Regular", rank: 10, permissions: ["read_messages", "send_messages"] });
  await createRoleDefinition("staff", { name: "Staff", rank: 50, permissions: ["read_messages", "send_messages"] });
  await createRoleDefinition("reviewer", { name: "Reviewer", rank: 60, permissions: ["read_messages", "view_reports"] });

  for (const [acct, role, set] of [
    ["acct-alice", "regular", (id: string) => (alice = id)],
    ["acct-bob", "regular", (id: string) => (bob = id)],
    ["acct-mallory", "regular", (id: string) => (mallory = id)],
    ["acct-staff", "staff", (id: string) => (staff = id)],
    ["acct-mod", "reviewer", (id: string) => (mod = id)],
  ] as const) {
    const user = await upsertUser(acct, acct);
    await setServerRole(user.server_user_id, role);
    set(user.server_user_id);
  }

  await upsertServerChannel({ channelId: OPEN, name: "Open", type: "text" });
  await upsertServerChannel({ channelId: PRIVATE, name: "Staff", type: "text" });
  const scope = await createPermissionScope({ isTemplate: false });
  await replacePermissionRules(scope, [
    { roleId: "regular", permission: "read_messages", effect: "deny" },
    { roleId: "reviewer", permission: "read_messages", effect: "deny" },
  ]);
  await setChannelPermissionScope(PRIVATE, scope);

  resetChannelIdCache();
  resetChannelPermissionCache();
});

beforeEach(() => resetFileAccessCache());

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("channel attachments", () => {
  it("are readable by anybody who can read the channel", async () => {
    const file = await newFile(alice);
    await send(OPEN, alice, file);
    assert.equal(await fileReadVerdict(file, mallory), "allowed");
  });

  it("in a private channel are refused to a member who cannot see it", async () => {
    const file = await newFile(staff);
    await send(PRIVATE, staff, file);
    assert.equal(await fileReadVerdict(file, mallory), "denied");
    assert.equal(await fileReadVerdict(file, alice), "denied");
  });

  it("in a private channel follow the role rules, not just the uploader", async () => {
    const file = await newFile(staff);
    await send(PRIVATE, staff, file);
    const other = await upsertUser("acct-staff-2", "Staff 2");
    await setServerRole(other.server_user_id, "staff");
    assert.equal(await fileReadVerdict(file, other.server_user_id), "allowed");
  });

  it("open up if the same file is also posted somewhere the reader can see", async () => {
    const file = await newFile(staff);
    await send(PRIVATE, staff, file);
    await send(OPEN, staff, file);
    assert.equal(await fileReadVerdict(file, mallory), "allowed");
  });

  it("close again once the only message carrying them is deleted", async () => {
    const file = await newFile(alice);
    const message = await send(OPEN, alice, file);
    assert.equal(await fileReadVerdict(file, mallory), "allowed");

    await deleteMessage(OPEN, message.message_id);
    resetFileAccessCache();
    assert.equal(await fileReadVerdict(file, mallory), "denied");
    assert.equal(await fileReadVerdict(file, alice), "allowed", "the uploader still can");
  });
});

describe("DM attachments", () => {
  it("are readable by both participants and nobody else on the server", async () => {
    const { conversation_id } = await openDirectConversation(alice, bob);
    const file = await newFile(alice);
    await send(conversation_id, alice, file);

    assert.equal(await fileReadVerdict(file, alice), "allowed");
    assert.equal(await fileReadVerdict(file, bob), "allowed");
    assert.equal(await fileReadVerdict(file, mallory), "denied");
    assert.equal(await fileReadVerdict(file, staff), "denied");
  });

  it("in a group are refused to somebody who left it", async () => {
    const group = await createGroupConversation(alice, [bob, mallory]);
    const file = await newFile(alice);
    await send(group.conversation_id, alice, file);
    assert.equal(await fileReadVerdict(file, mallory), "allowed");

    await leaveConversation(group.conversation_id, mallory);
    resetFileAccessCache();
    assert.equal(await fileReadVerdict(file, mallory), "denied");
  });
});

describe("pending uploads", () => {
  it("are readable by the uploader alone", async () => {
    const file = await newFile(alice);
    assert.equal(await fileReadVerdict(file, alice), "allowed");
    assert.equal(await fileReadVerdict(file, bob), "denied");
  });

  it("are not cached as refused, so the message that sends one opens it", async () => {
    const file = await newFile(alice);
    assert.equal(await fileReadVerdict(file, bob), "denied");
    await send(OPEN, alice, file);
    assert.equal(await fileReadVerdict(file, bob), "allowed");
  });
});

describe("public server assets", () => {
  it("a member's avatar is readable by every member", async () => {
    const file = await newFile(alice);
    await setUserAvatar(alice, file);
    assert.equal(await fileReadVerdict(file, mallory), "allowed");
  });

  it("a webhook's avatar is readable by every member", async () => {
    const file = await newFile(staff);
    await createWebhook(PRIVATE, "Hook", staff, file);
    assert.equal(await fileReadVerdict(file, mallory), "allowed");
  });

  it("a group picture is readable by the group and nobody else", async () => {
    const group = await createGroupConversation(alice, [bob, staff]);
    const file = await newFile(null);
    await setConversationIcon(group.conversation_id, file);
    assert.equal(await fileReadVerdict(file, bob), "allowed");
    assert.equal(await fileReadVerdict(file, mallory), "denied");
  });
});

describe("unknown and unowned files", () => {
  it("refuses an id with no file", async () => {
    assert.equal(await fileReadVerdict(randomUUID(), alice), "denied");
  });

  it("lets any member read an older file nothing points at and nobody is recorded as uploading", async () => {
    const file = await newFile(null);
    assert.equal(await fileReadVerdict(file, alice), "allowed");
    assert.equal(await fileReadVerdict(file, mallory), "allowed");
    assert.equal(await fileReadVerdict(file, null), "denied", "still not without signing in");
  });

  it("gates an older file by where it was sent once it is attached", async () => {
    const file = await newFile(null);
    await send(PRIVATE, staff, file);
    resetFileAccessCache();
    assert.equal(await fileReadVerdict(file, staff), "allowed");
    assert.equal(await fileReadVerdict(file, mallory), "denied");
  });

  it("keeps a new upload to its uploader until it is sent", async () => {
    const file = await newFile(alice);
    assert.equal(await fileReadVerdict(file, alice), "allowed");
    assert.equal(await fileReadVerdict(file, mallory), "denied");
  });

  it("refuses somebody who is not signed in", async () => {
    const file = await newFile(alice);
    await send(OPEN, alice, file);
    assert.equal(await fileReadVerdict(file, null), "denied");
    assert.equal(await fileReadVerdict(file, "temp_abc"), "denied");
  });
});

describe("reported attachments", () => {
  it("are readable by a moderator from a DM they are not in", async () => {
    const { conversation_id } = await openDirectConversation(alice, bob);
    const file = await newFile(alice);
    const message = await send(conversation_id, alice, file);
    assert.equal(await fileReadVerdict(file, mod), "denied", "not before it is reported");

    await insertReport({
      message_id: message.message_id,
      conversation_id,
      reporter_server_user_id: bob,
      message_text: null,
      message_attachments: [file],
      message_sender_server_id: alice,
      message_sender_nickname: "alice",
    });
    assert.equal(await fileReadVerdict(file, mod), "allowed");
    assert.equal(await fileReadVerdict(file, mallory), "denied", "reporting does not publish it");
  });

  it("stay hidden from a moderator who cannot see the channel", async () => {
    const file = await newFile(staff);
    const message = await send(PRIVATE, staff, file);
    await insertReport({
      message_id: message.message_id,
      conversation_id: PRIVATE,
      reporter_server_user_id: staff,
      message_text: null,
      message_attachments: [file],
      message_sender_server_id: staff,
      message_sender_nickname: "staff",
    });
    assert.equal(await fileReadVerdict(file, mod), "denied");
  });
});

describe("the migration", () => {
  it("backfills ownership for attachments sent before it existed", async () => {
    const { conversation_id } = await openDirectConversation(alice, bob);
    const file = await newFile(null);
    await send(conversation_id, alice, file);

    const db = getSqliteDb();
    db.exec("DROP TABLE message_attachments");
    db.close();
    await initSqlite();
    resetFileAccessCache();

    assert.equal(await fileReadVerdict(file, bob), "allowed");
    assert.equal(await fileReadVerdict(file, mallory), "denied");
  });
});
