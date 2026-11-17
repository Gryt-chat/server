/* eslint-disable @typescript-eslint/no-restricted-types -- fake discord.js objects are cast through unknown; they only have what outbound reads */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Client } from "discord.js";

import { discordMessageFor, saveDiscordBridgeApp, saveDiscordBridgeChannel, setExcludedFromBridge, updateDiscordBridge, type MessageRecord } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { messageCreated, messageEdited, messageDeleted, setOutboundClient, setWebhookFactory } from "./outbound";

let dir: string;
const CHANNEL = "600000000000000002";
const conv = "gryt-general";
const posted: { op: string; arg: unknown }[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-out-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  saveDiscordBridgeApp("600000000000000000", "token");
  updateDiscordBridge({ status: "linked", guild_id: "600000000000000001", guild_name: "Night Owls", direction: "both" });
  saveDiscordBridgeChannel({ discord_channel_id: CHANNEL, gryt_channel_id: conv, backfill_before: null, backfill_done: true });
  let n = 0;
  setWebhookFactory(() => ({
    send: (async (arg: unknown) => {
      posted.push({ op: "send", arg });
      return { id: `60000000000000010${n++}` };
    }) as never,
    editMessage: (async (id: string, arg: unknown) => {
      posted.push({ op: "edit", arg: { id, arg } });
      return {};
    }) as never,
    deleteMessage: (async (id: string) => {
      posted.push({ op: "delete", arg: id });
    }) as never,
  }));
  const channel = { createWebhook: async () => ({ id: "600000000000000009", token: "hook-token" }) };
  setOutboundClient(() => ({ channels: { fetch: async () => channel } }) as unknown as Client);
});

after(() => rmSync(dir, { recursive: true, force: true }));

function message(over: Partial<MessageRecord> = {}): MessageRecord & { sender_nickname: string } {
  return {
    conversation_id: conv,
    message_id: "m1",
    sender_server_id: "user_adder",
    text: "count me in",
    attachments: null,
    reactions: null,
    reply_to_message_id: null,
    created_at: new Date(),
    sender_nickname: "Adder",
    ...over,
  } as MessageRecord & { sender_nickname: string };
}

describe("Gryt to Discord", () => {
  it("posts a member's message under their name and remembers it", async () => {
    await messageCreated(message());
    const send = posted.find((p) => p.op === "send")?.arg as { content: string; username: string };
    assert.equal(send.content, "count me in");
    assert.equal(send.username, "Adder");
    assert.equal(discordMessageFor("m1")?.from_gryt, true);
  });

  it("never posts a Discord person's message back", async () => {
    posted.length = 0;
    await messageCreated(message({ message_id: "m2", sender_server_id: "discord:123" }));
    assert.equal(posted.length, 0);
  });

  it("follows an edit and a delete through the webhook", async () => {
    posted.length = 0;
    await messageEdited(message({ text: "count me in, bringing snacks" }));
    await messageDeleted("m1");
    assert.deepEqual(posted.map((p) => p.op), ["edit", "delete"]);
  });

  it("doesn't post a member the owner switched off", async () => {
    setExcludedFromBridge("gryt", "user_skip", true);
    posted.length = 0;
    await messageCreated(message({ message_id: "m4", sender_server_id: "user_skip" }));
    assert.equal(posted.length, 0);
  });

  it("leaves out what the owner switched off", async () => {
    updateDiscordBridge({ sync_off: JSON.stringify(["edits"]) });
    posted.length = 0;
    await messageEdited(message({ text: "edited again" }));
    assert.equal(posted.length, 0);
    updateDiscordBridge({ sync_off: "[]" });
  });

  it("stays quiet when the bridge only copies into Gryt", async () => {
    updateDiscordBridge({ direction: "to_gryt" });
    posted.length = 0;
    await messageCreated(message({ message_id: "m3" }));
    assert.equal(posted.length, 0);
  });
});
