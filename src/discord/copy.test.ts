/* eslint-disable @typescript-eslint/no-restricted-types -- the fake guild is cast through unknown; it only has what copyGuild reads */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ChannelType, MessageType, type Guild } from "discord.js";

import { getServerChannel, listMessages, listThreadsByConversation } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { importedId } from "../import/discord/ids";
import type { ImportMedia } from "../import/discord/importer";
import { isDiscordCdn } from "./assets";
import { copyGuild } from "./copy";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-copy-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const media: ImportMedia = {
  storeFile: async () => ({ kind: "stored" }),
  queueEmoji: async () => false,
};

function message(n: number, id = `7000000000000${String(n).padStart(5, "0")}`) {
  return {
    id,
    channelId: "800000000000000001",
    type: MessageType.Default,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
    createdTimestamp: Date.UTC(2026, 0, 1, 0, 0, n),
    editedAt: null,
    pinned: false,
    content: `message ${n}`,
    author: { id: "900000000000000001", globalName: "pixelfox", username: "pixelfox", bot: false, displayAvatarURL: () => "https://example.com/a.png" },
    member: null,
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: { users: new Map(), members: null },
    reference: null,
  };
}

/** 101 messages, so the copy needs two pages. Newest first, like Discord. */
function fakeGuild(): Guild {
  const all = Array.from({ length: 101 }, (_, i) => message(i + 1)).reverse();
  const general = {
    id: "800000000000000001",
    type: ChannelType.GuildText,
    name: "general",
    topic: "Hang out",
    parentId: null,
    position: 0,
    isTextBased: () => true,
    messages: {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => {
        const start = before ? all.findIndex((m) => m.id === before) + 1 : 0;
        return new Map(all.slice(start, start + limit).map((m) => [m.id, m]));
      },
    },
  };
  const thread = (id: string, name: string, msgs: ReturnType<typeof message>[]) => ({
    id,
    name,
    parentId: general.id,
    messages: { fetch: async () => new Map([...msgs].reverse().map((m) => [m.id, m])) },
  });
  // Started from message 50, so its root is already in the channel.
  const fromMessage = thread(all.find((m) => m.content === "message 50")!.id, "snacks", [message(201, "6100000000000000201"), message(202, "6100000000000000202")]);
  // Nothing in the channel points at it, like a forum post: its first message becomes the root.
  const post = thread("6200000000000000000", "lfg friday", [message(301, "6200000000000000301"), message(302, "6200000000000000302")]);
  return {
    channels: {
      fetch: async () => new Map([[general.id, { ...general, threads: { fetchArchived: async () => ({ threads: new Map(), hasMore: false }) } }]]),
      fetchActiveThreads: async () => ({ threads: new Map([[fromMessage.id, fromMessage], [post.id, post]]) }),
    },
    emojis: { fetch: async () => new Map() },
  } as unknown as Guild;
}

describe("copying a Discord server", () => {
  it("copies every page of a channel under Discord-derived ids", async () => {
    const progress = await copyGuild(fakeGuild(), { media, startedBy: "user_owner" });
    const channelId = importedId("channel", "800000000000000001");

    assert.equal((await getServerChannel(channelId))?.name, "general");
    assert.equal(progress.messages_imported, 105);
    const latest = await listMessages(channelId, 5);
    assert.ok(latest.some((m) => m.text === "message 101"));
    assert.equal(latest[0].sender_server_id, "discord:900000000000000001");
  });

  it("copies threads under their root, making one for a post with none", async () => {
    const threads = await listThreadsByConversation(importedId("channel", "800000000000000001"));
    assert.deepEqual(threads.map((t) => t.title).sort(), ["lfg friday", "snacks"]);
    assert.equal(threads.find((t) => t.title === "snacks")?.root_message_id, importedId("message", "700000000000000050"));
    assert.equal(threads.find((t) => t.title === "lfg friday")?.root_message_id, importedId("message", "6200000000000000301"));
  });

  it("copies nothing twice when run again", async () => {
    const progress = await copyGuild(fakeGuild(), { media, startedBy: "user_owner" });
    assert.equal(progress.messages_imported, 0);
  });

  it("only downloads from Discord's CDN", () => {
    assert.equal(isDiscordCdn("https://cdn.discordapp.com/attachments/1/2/a.png"), true);
    assert.equal(isDiscordCdn("https://evil.example/a.png"), false);
    assert.equal(isDiscordCdn("http://cdn.discordapp.com/a.png"), false);
  });
});
