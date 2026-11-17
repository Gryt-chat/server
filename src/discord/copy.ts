import { join } from "node:path";

import consola from "consola";
import { ChannelType, MessageType, type AnyThreadChannel, type Guild, type Message, type NonThreadGuildBasedChannel } from "discord.js";

import {
  DEFAULT_UPLOAD_MAX_BYTES,
  getDiscordBridgeChannel,
  grytChannelFor,
  getServerConfig,
  insertImportedMessages,
  isExcludedFromBridge,
  rememberDiscordMessages,
  saveDiscordBridgeChannel,
  type DiscordImportProgress,
} from "../db";
import { clip, emojiName } from "../import/discord/content";
import { importedId } from "../import/discord/ids";
import { createImportedChannels, emptyProgress, importThreadMessages, type ChannelPlan, type ImportMedia } from "../import/discord/importer";
import { DiscordRowBuilder } from "../import/discord/rows";
import { toDceMessage } from "./adapter";
import { broadcastServerUiUpdate } from "../socket/utils/server";
import { discordCdnAssets } from "./assets";
import { takeDiscordIdentity } from "./identity";
import { importRoles } from "./roles";

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** Discord's most per request. */
const PAGE = 100;

export interface CopyOptions {
  media: ImportMedia;
  startedBy: string;
  onProgress?: (progress: DiscordImportProgress) => void;
  /** Checked between pages: true stops the copy where it is, to resume later. */
  stopped?: () => boolean;
  identity?: boolean;
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

/** Copies the server's channels, their history and their public threads. Safe to rerun:
    rows carry ids derived from Discord's, and each channel resumes where it stopped. */
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

  if (opts.identity) await takeDiscordIdentity(guild, assets).catch((e) => warn(`name and icon: ${e instanceof Error ? e.message : String(e)}`));
  await importRoles(guild).catch((e) => warn(`roles: ${e instanceof Error ? e.message : String(e)}`));
  const channels = [...(await guild.channels.fetch()).values()].filter((c): c is NonThreadGuildBasedChannel => !!c);
  const plans = plan(channels).flatMap((p) => {
    const target = grytChannelFor(p.id, importedId("channel", p.id));
    return target ? [{ ...p, grytChannelId: target }] : [];
  });
  const names = new Map(plans.map((p) => [p.id, p.name]));
  const rows = new DiscordRowBuilder(opts.media, progress, warn, names);
  progress.channels_total = plans.length;
  progress.channels = plans.map((p) => ({ name: p.name, messages: 0, done: false }));
  await createImportedChannels(plans);
  broadcastServerUiUpdate("other");
  const notices = new Map<string, string>();

  try {
    for (const [i, p] of plans.entries()) {
      if (opts.stopped?.()) return progress;
      progress.current_channel = p.name;
      opts.onProgress?.({ ...progress });
      const channel = channels.find((c) => c.id === p.id);
      const row = progress.channels[i];
      const before = progress.messages_imported + progress.messages_already_there;
      if (channel?.isTextBased()) await copyHistory(channel.id, p.grytChannelId ?? importedId("channel", p.id), (b) => channel.messages.fetch({ limit: PAGE, ...(b ? { before: b } : {}) }), rows, progress, warn, assets, opts, notices);
      if (opts.stopped?.()) return progress;
      row.messages = progress.messages_imported + progress.messages_already_there - before;
      row.done = true;
      progress.channels_done += 1;
    }

    const threads = (await listThreads(guild, channels, warn)).flatMap((t) => {
      const parent = t.parentId ? grytChannelFor(t.parentId, importedId("channel", t.parentId)) : null;
      return parent ? [{ t, parent }] : [];
    });
    progress.channels_total += threads.length;
    for (const { t, parent } of threads) {
      if (opts.stopped?.()) return progress;
      progress.current_channel = t.name;
      opts.onProgress?.({ ...progress });
      await copyThread(t, parent, notices.get(t.id) ?? null, rows, progress, warn, assets);
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
    broadcastServerUiUpdate("other");
  }
  return progress;
}

async function copyHistory(
  discordChannelId: string,
  conversationId: string,
  fetchPage: (before: string | null) => Promise<Map<string, Message>>,
  rows: DiscordRowBuilder,
  progress: DiscordImportProgress,
  warn: (m: string) => void,
  assets: ReturnType<typeof discordCdnAssets>,
  opts: CopyOptions,
  notices: Map<string, string>,
): Promise<void> {
  const cursor = getDiscordBridgeChannel(discordChannelId) ?? { discord_channel_id: discordChannelId, gryt_channel_id: conversationId, backfill_before: null, backfill_done: false };
  if (cursor.backfill_done) return;

  for (;;) {
    if (opts.stopped?.()) return;
    let page: Message[];
    try {
      page = [...(await fetchPage(cursor.backfill_before)).values()];
    } catch (e) {
      warn(`#${discordChannelId}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const built = [];
    for (const m of page) {
      if (m.type === MessageType.ThreadCreated && m.reference?.channelId) notices.set(m.reference.channelId, m.id);
      if (isExcludedFromBridge("discord", m.author.id)) continue;
      const row = await rows.buildRow(toDceMessage(m), assets, conversationId, discordChannelId, null);
      if (row) built.push(row);
    }
    const inserted = insertImportedMessages(built);
    rememberDiscordMessages(page.map((m) => linkOf(m, conversationId)));
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

/** Active and archived public threads under the copied channels. Private ones need more than the bot asks for. */
async function listThreads(guild: Guild, channels: NonThreadGuildBasedChannel[], warn: (m: string) => void): Promise<AnyThreadChannel[]> {
  const found = new Map<string, AnyThreadChannel>();
  try {
    for (const t of (await guild.channels.fetchActiveThreads()).threads.values()) found.set(t.id, t);
  } catch (e) {
    warn(`active threads: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const c of channels) {
    if (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildAnnouncement && c.type !== ChannelType.GuildForum) continue;
    let before: string | undefined;
    for (;;) {
      try {
        const page = await c.threads.fetchArchived({ type: "public", limit: PAGE, ...(before ? { before } : {}) });
        for (const t of page.threads.values()) found.set(t.id, t);
        const last = [...page.threads.values()].at(-1);
        if (!page.hasMore || !last) break;
        before = last.id;
      } catch (e) {
        warn(`#${c.name} archived threads: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
  }
  return [...found.values()].filter((t) => !!t.parentId);
}

async function copyThread(
  t: AnyThreadChannel,
  conversationId: string,
  noticeId: string | null,
  rows: DiscordRowBuilder,
  progress: DiscordImportProgress,
  warn: (m: string) => void,
  assets: ReturnType<typeof discordCdnAssets>,
): Promise<void> {
  const parentId = t.parentId;
  if (!parentId || getDiscordBridgeChannel(t.id)?.backfill_done) return;
  const all: Message[] = [];
  let before: string | undefined;
  try {
    for (;;) {
      const page = [...(await t.messages.fetch({ limit: PAGE, ...(before ? { before } : {}) })).values()];
      all.push(...page);
      if (page.length < PAGE) break;
      before = page.reduce((min, m) => (m.createdTimestamp < min.createdTimestamp ? m : min)).id;
    }
  } catch (e) {
    warn(`thread "${t.name}": ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const kept = all.filter((m) => !isExcludedFromBridge("discord", m.author.id));
  rememberDiscordMessages(all.map((m) => linkOf(m, conversationId)));
  await importThreadMessages({
    thread: { id: t.id, name: clip(t.name, 80) ?? `thread-${t.id}`, parentId, conversationId },
    messages: kept.map(toDceMessage),
    noticeId,
    rows,
    assets,
    progress,
    warn,
    flush: async (batch) => {
      const inserted = insertImportedMessages(batch);
      progress.messages_imported += inserted;
      progress.messages_already_there += batch.length - inserted;
    },
  });
  saveDiscordBridgeChannel({ discord_channel_id: t.id, gryt_channel_id: importedId("thread", t.id), backfill_before: null, backfill_done: true });
}

/** A Discord message's place in the map. Its Gryt id is derived from its Discord id, like every copied row. */
export function linkOf(m: { id: string; channelId: string }, conversationId: string) {
  return { gryt_message_id: importedId("message", m.id), gryt_conversation_id: conversationId, discord_channel_id: m.channelId, discord_message_id: m.id, from_gryt: false };
}

