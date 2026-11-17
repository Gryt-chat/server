/* eslint-disable @typescript-eslint/no-restricted-types -- fake discord.js objects are cast through unknown; they only have what the listener reads */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Events, MessageType, type Client } from "discord.js";
import type { Server } from "socket.io";

import { getMessageById, saveDiscordBridgeApp, updateDiscordBridge, upsertServerChannel } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { importedId } from "../import/discord/ids";
import type { ImportMedia } from "../import/discord/importer";
import { clearPluginRefs, setPluginRefs } from "../plugins/refs";
import { attachLiveSync } from "./live";

let dir: string;
const GUILD = "500000000000000001";
const CHANNEL = "500000000000000002";
const MSG = "500000000000000003";
const conversationId = importedId("channel", CHANNEL);
const messageId = importedId("message", MSG);

const media: ImportMedia = { storeFile: async () => ({ kind: "stored" }), queueEmoji: async () => false };

function fakeMessage(content: string, pinned = false) {
  return {
    id: MSG,
    guildId: GUILD,
    partial: false,
    type: MessageType.Default,
    createdAt: new Date(Date.UTC(2026, 10, 17, 20, 41)),
    createdTimestamp: Date.UTC(2026, 10, 17, 20, 41),
    editedAt: null,
    pinned,
    content,
    channel: { id: CHANNEL, isThread: () => false },
    author: { id: "500000000000000009", globalName: "pixelfox", username: "pixelfox", bot: false, displayAvatarURL: () => "https://example.com/a.png" },
    member: null,
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: { users: new Map(), members: null },
    reference: null,
  };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

let client: EventEmitter & { user: { id: string } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-live-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await upsertServerChannel({ channelId: conversationId, name: "general", type: "text", position: 1 });
  saveDiscordBridgeApp("500000000000000000", "token");
  updateDiscordBridge({ status: "linked", guild_id: GUILD, guild_name: "Night Owls", direction: "both" });
  setPluginRefs({ io: { sockets: { sockets: new Map() } } as unknown as Server, serverId: "s", clientsInfo: {}, sfuClient: null });
  client = Object.assign(new EventEmitter(), { user: { id: "500000000000000008" } });
  attachLiveSync(client as unknown as Client, media);
});

after(() => {
  clearPluginRefs();
  rmSync(dir, { recursive: true, force: true });
});

describe("live Discord sync", () => {
  it("copies a new message", async () => {
    client.emit(Events.MessageCreate, fakeMessage("squad night is friday"));
    await until(async () => (await getMessageById(conversationId, messageId))?.text === "squad night is friday");
  });

  it("follows an edit", async () => {
    client.emit(Events.MessageUpdate, fakeMessage("squad night is friday"), fakeMessage("squad night is saturday"));
    await until(async () => (await getMessageById(conversationId, messageId))?.text === "squad night is saturday");
  });

  it("adds a reaction as the Discord user who left it", async () => {
    const reaction = { emoji: { id: null, name: "👍" }, message: fakeMessage("squad night is saturday") };
    client.emit(Events.MessageReactionAdd, reaction, { id: "500000000000000010" });
    await until(async () => {
      const r = (await getMessageById(conversationId, messageId))?.reactions ?? [];
      return r.some((x) => x.src === "👍" && x.users.includes("discord:500000000000000010"));
    });
  });

  it("follows a pin", async () => {
    client.emit(Events.MessageUpdate, fakeMessage("squad night is saturday"), fakeMessage("squad night is saturday", true));
    await until(async () => !!(await getMessageById(conversationId, messageId))?.pinned_at);
  });

  it("ignores the bot's own messages", async () => {
    const own = { ...fakeMessage("from the bridge"), id: "500000000000000011", author: { ...fakeMessage("").author, id: "500000000000000008" } };
    client.emit(Events.MessageCreate, own);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await getMessageById(conversationId, importedId("message", "500000000000000011")), null);
  });

  it("leaves out channels that weren't copied", async () => {
    const elsewhere = { ...fakeMessage("not here"), id: "500000000000000012", channel: { id: "500000000000000013", isThread: () => false } };
    client.emit(Events.MessageCreate, elsewhere);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await getMessageById(importedId("channel", "500000000000000013"), importedId("message", "500000000000000012")), null);
  });

  it("follows a delete", async () => {
    client.emit(Events.MessageDelete, fakeMessage("squad night is saturday"));
    await until(async () => (await getMessageById(conversationId, messageId)) === null);
  });
});
