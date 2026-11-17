import { join } from "node:path";

import consola from "consola";
import { ChannelType, type Guild, type Message, type NonThreadGuildBasedChannel } from "discord.js";

import {
  DEFAULT_UPLOAD_MAX_BYTES,
  getDiscordBridgeChannel,
  getServerConfig,
  insertImportedMessages,
  saveDiscordBridgeChannel,
  type DiscordImportProgress,
} from "../db";
import { clip, emojiName } from "../import/discord/content";
import { importedId } from "../import/discord/ids";
import { createImportedChannels, emptyProgress, type ChannelPlan, type ImportMedia } from "../import/discord/importer";
import { DiscordRowBuilder } from "../import/discord/rows";
import { toDceMessage } from "./adapter";
import { discordCdnAssets } from "./assets";

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** Discord's most per request. */
const PAGE = 100;

export interface CopyOptions {
  media: ImportMedia;
  startedBy: string;
  onProgress?: (progress: DiscordImportProgress) => void;
}

function plan(channels: NonThreadGuildBasedChannel[]): ChannelPlan[] {
  const categories = new Map(channels.filter((c) => c.type === ChannelType.GuildCategory).map((c) => [c.id, c.name]));
  const plans: ChannelPlan[] = [];
  for (const c of channels.sort((a, b) => ("position" in a && "position" in b ? a.position - b.position : 0))) {
    let kind: ChannelPlan["kind"] | null = null;
    if (TEXT_TYPES.has(c.type)) kind = "text";
    else if (VOICE_TYPES.has(c.type)) kind = "voice";
    else if (c.type === ChannelType.GuildForum) kind = "forum";
    if (!kind) continue;
    const categoryId = c.parentId && categories.has(c.parentId) ? c.parentId : null;
    plans.push({
      id: c.id,
      name: clip(c.name, 80) ?? `channel-${c.id}`,
      kind,
      topic: "topic" in c ? (clip(c.topic, 200) ?? null) : null,
      categoryId,
      categoryName: categoryId ? (clip(categories.get(categoryId), 80) ?? null) : null,
    });
  }
  return plans;
}

/** Copies the server's channels and their history, newest page first. Safe to rerun:
    rows carry ids derived from Discord's, and each channel resumes where it stopped. Threads come later. */
export async function copyGuild(guild: Guild, opts: CopyOptions): Promise<DiscordImportProgress> {
  const progress = emptyProgress();
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (warnings.length < 200) warnings.push(m);
    consola.warn(`[DiscordBridge] ${m}`);
  };
  const cfg = await getServerConfig().catch(() => null);
  const maxBytes = typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES;
  const assets = discordCdnAssets(join(process.env.DATA_DIR || "./data", "tmp", "discord-bridge"), maxBytes);

  const channels = [...(await guild.channels.fetch()).values()].filter((c): c is NonThreadGuildBasedChannel => !!c);
  const plans = plan(channels);
  const names = new Map(plans.map((p) => [p.id, p.name]));
  const rows = new DiscordRowBuilder(opts.media, progress, warn, names);
  progress.channels_total = plans.length;
  await createImportedChannels(plans);

  try {
    for (const p of plans) {
      progress.current_channel = p.name;
      opts.onProgress?.({ ...progress });
      const channel = channels.find((c) => c.id === p.id);
      if (channel?.isTextBased()) await copyHistory(channel.id, (before) => channel.messages.fetch({ limit: PAGE, ...(before ? { before } : {}) }), rows, progress, warn, assets, opts);
      progress.channels_done += 1;
    }

    for (const e of (await guild.emojis.fetch()).values()) {
      const name = emojiName(e.name ?? undefined);
      const found = name ? await assets.resolve(e.imageURL({ extension: "png" })) : null;
      if (name && found && (await opts.media.queueEmoji({ name, path: found.path, uploadedBy: opts.startedBy }))) progress.emojis_queued += 1;
    }
  } finally {
    progress.current_channel = null;
    opts.onProgress?.({ ...progress });
    await assets.cleanup();
  }
  return progress;
}

async function copyHistory(
  discordChannelId: string,
  fetchPage: (before: string | null) => Promise<Map<string, Message>>,
  rows: DiscordRowBuilder,
  progress: DiscordImportProgress,
  warn: (m: string) => void,
  assets: ReturnType<typeof discordCdnAssets>,
  opts: CopyOptions,
): Promise<void> {
  const conversationId = importedId("channel", discordChannelId);
  const cursor = getDiscordBridgeChannel(discordChannelId) ?? { discord_channel_id: discordChannelId, gryt_channel_id: conversationId, backfill_before: null, backfill_done: false };
  if (cursor.backfill_done) return;

  for (;;) {
    let page: Message[];
    try {
      page = [...(await fetchPage(cursor.backfill_before)).values()];
    } catch (e) {
      warn(`#${discordChannelId}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const built = [];
    for (const m of page) {
      const row = await rows.buildRow(toDceMessage(m), assets, conversationId, discordChannelId, null);
      if (row) built.push(row);
    }
    const inserted = insertImportedMessages(built);
    progress.messages_imported += inserted;
    progress.messages_already_there += built.length - inserted;

    const oldest = page.reduce<Message | null>((min, m) => (!min || m.createdTimestamp < min.createdTimestamp ? m : min), null);
    cursor.backfill_before = oldest?.id ?? cursor.backfill_before;
    cursor.backfill_done = page.length < PAGE;
    saveDiscordBridgeChannel(cursor);
    opts.onProgress?.({ ...progress });
    if (cursor.backfill_done) return;
  }
}
