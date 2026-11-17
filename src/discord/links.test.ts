import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getMessageById, insertImportedMessages, linkDiscordMember, unlinkDiscordMember } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { upsertUser } from "../db/sqlite/users";
import { enrichSenders } from "../socket/handlers/chat";
import { forgetDiscordPerson, issueLinkCode, redeemLinkCode } from "./commands";

let dir: string;
const DISCORD_ID = "700000000000000077";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-links-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => rmSync(dir, { recursive: true, force: true }));

function row(id: string) {
  return {
    conversation_id: "general",
    message_id: id,
    sender_server_id: `discord:${DISCORD_ID}`,
    sender_display_name: "kestrel_",
    sender_avatar_file_id: null,
    text: "hi from discord",
    attachments: [],
    reactions: [],
    cards: [],
    reply_to_message_id: null,
    thread_id: null,
    created_at: new Date(),
    edited_at: null,
    media_file_ids: [],
  };
}

describe("linking Discord people to members", () => {
  it("takes a /link code once, and not again", () => {
    const code = issueLinkCode(DISCORD_ID, "kestrel_");
    assert.equal(redeemLinkCode(code.toLowerCase())?.discordUserId, DISCORD_ID);
    assert.equal(redeemLinkCode(code), null);
    assert.equal(redeemLinkCode("NOTACODE"), null);
  });

  it("shows a linked person as their member, and as themselves again once unlinked", async () => {
    insertImportedMessages([row("d1")]);
    const member = await upsertUser("account-links-1", "Adder");
    const message = await getMessageById("general", "d1");
    assert.ok(message);

    linkDiscordMember(DISCORD_ID, member.server_user_id, member.server_user_id, "code");
    assert.equal((await enrichSenders([message]))[0].sender_nickname, "Adder");

    unlinkDiscordMember(DISCORD_ID);
    assert.equal((await enrichSenders([message]))[0].sender_nickname, "kestrel_");
  });

  it("removes everything a person wrote when they ask", async () => {
    insertImportedMessages([row("d2"), row("d3")]);
    const removed = await forgetDiscordPerson(DISCORD_ID);
    assert.equal(removed, 3);
    assert.equal(await getMessageById("general", "d2"), null);
  });
});
