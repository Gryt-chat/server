/* eslint-disable @typescript-eslint/no-restricted-types -- fake discord.js objects are cast through unknown; they only have what the listener reads */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ChannelType, Events, type Client } from "discord.js";

import { getServerChannel, grytChannelFor, saveDiscordBridgeApp, updateDiscordBridge } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { importedId } from "../import/discord/ids";
import { attachLayoutSync } from "./layout";

let dir: string;
const GUILD = "900000000000000001";
const ID = "900000000000000002";
const client = new EventEmitter();

function channel(name: string, topic: string | null) {
  return { id: ID, guildId: GUILD, type: ChannelType.GuildText, name, topic, parentId: null, parent: null, isDMBased: () => false };
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-layout-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  saveDiscordBridgeApp("900000000000000000", "token");
  updateDiscordBridge({ status: "linked", guild_id: GUILD, guild_name: "Night Owls", direction: "both", copy_status: "done" });
  attachLayoutSync(client as unknown as Client);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("Discord layout into Gryt", () => {
  const id = importedId("channel", ID);

  it("makes a channel for a new Discord one", async () => {
    client.emit(Events.ChannelCreate, channel("memes", "only the good ones"));
    await until(async () => (await getServerChannel(id))?.name === "memes");
  });

  it("follows a rename and a new topic", async () => {
    client.emit(Events.ChannelUpdate, channel("memes", "only the good ones"), channel("memes-and-clips", "both now"));
    await until(async () => (await getServerChannel(id))?.description === "both now");
    assert.equal((await getServerChannel(id))?.name, "memes-and-clips");
  });

  it("stops syncing a deleted Discord channel, and keeps the Gryt one", async () => {
    client.emit(Events.ChannelDelete, channel("memes-and-clips", "both now"));
    await until(() => grytChannelFor(ID, id) === null);
    assert.ok(await getServerChannel(id));
  });
});
