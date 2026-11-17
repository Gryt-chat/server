import { join } from "node:path";

import consola from "consola";
import {
  Events,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";

import {
  DEFAULT_UPLOAD_MAX_BYTES,
  addReactionToMessage,
  bridgeWebhookIds,
  getServerConfig,
  getDiscordBridge,
  getMessageById,
  getServerChannel,
  getThread,
  insertImportedMessages,
  rememberDiscordMessages,
  refreshImportedThreadCounters,
  removeReactionFromMessage,
  setMessagePinned,
  updateMessageText,
  type MessageRecord,
} from "../db";
import { deleteMessageEverywhere } from "../moderation/deleteMessage";
import { pluginRefs } from "../plugins/refs";
import { emojiName } from "../import/discord/content";
import { discordSenderId, importedId } from "../import/discord/ids";
import { emptyProgress, importThreadMessages, type ImportMedia } from "../import/discord/importer";
import { DiscordRowBuilder } from "../import/discord/rows";
import { enrichAttachments, enrichSenders } from "../socket/handlers/chat";
import { appendCachedMessage, replaceCachedMessage } from "../socket/utils/messageCache";
import { recipientClientIds } from "../socket/utils/recipients";
import { toDceMessage } from "./adapter";
import { linkOf } from "./copy";
import { discordCdnAssets } from "./assets";

const CHANNEL_ACCESS = { allowed: true, kind: "channel" } as const;

interface Place {
  conversationId: string;
  discordChannelId: string;
  threadId: string | null;
}

/** Discord's view of where a message is, in Gryt's terms. Null outside the linked server or a channel not copied yet. */
async function placeOf(m: Message | PartialMessage, botId: string | undefined): Promise<Place | null> {
  const b = getDiscordBridge();
  if (!b || m.guildId !== b.guild_id || b.direction === "to_discord") return null;
  if (m.author?.id && m.author.id === botId) return null;
  // Gryt's own messages, posted by the bridge's webhooks, coming back.
  if (m.webhookId && bridgeWebhookIds().has(m.webhookId)) return null;
  const ch = m.channel;
  const parent = ch.isThread() ? ch.parentId : ch.id;
  if (!parent) return null;
  const conversationId = importedId("channel", parent);
  if (!(await getServerChannel(conversationId))) return null;
  return { conversationId, discordChannelId: ch.id, threadId: ch.isThread() ? importedId("thread", ch.id) : null };
}

function reactionSrc(r: MessageReaction | PartialMessageReaction): string | null {
  if (!r.emoji.id) return r.emoji.name ?? null;
  const name = emojiName(r.emoji.name ?? undefined);
  return name ? `:${name}:` : null;
}

/** What history sends: a Discord author by the name on the row, or their member once linked. */
async function view(m: MessageRecord): Promise<MessageRecord> {
  const [named] = await enrichSenders([m]);
  const [withFiles] = await enrichAttachments([named]);
  return withFiles;
}

async function emit(conversationId: string, event: string, payload: object): Promise<void> {
  const refs = pluginRefs();
  if (!refs) return;
  for (const cid of await recipientClientIds(conversationId, CHANNEL_ACCESS, refs.clientsInfo, refs.sfuClient)) {
    refs.io.sockets.sockets.get(cid)?.emit(event, payload);
  }
}

/** Keeps Gryt in step with Discord: new messages, edits, pins, deletes and reactions. */
export function attachLiveSync(c: Client, media: ImportMedia): void {
  const progress = emptyProgress();
  const warn = (m: string) => consola.warn(`[DiscordBridge] ${m}`);
  const rows = new DiscordRowBuilder(media, progress, warn, new Map());
  const botId = () => c.user?.id;

  const guarded = <A extends object[]>(name: string, fn: (...a: A) => Promise<void>) =>
    (...a: A) => {
      fn(...a).catch((e) => consola.warn(`[DiscordBridge] ${name} failed`, e));
    };

  /** A fresh download folder per event, removed when it's done; stored files are known by id after that. */
  async function withAssets<T>(fn: (assets: ReturnType<typeof discordCdnAssets>) => Promise<T>): Promise<T> {
    const cfg = await getServerConfig().catch(() => null);
    const max = typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES;
    const assets = discordCdnAssets(join(process.env.DATA_DIR || "./data", "tmp", `discord-live-${Date.now()}-${Math.random().toString(36).slice(2)}`), max);
    try {
      return await fn(assets);
    } finally {
      await assets.cleanup();
    }
  }

  c.on(Events.MessageCreate, guarded("new message", async (m: Message) => {
    const place = await placeOf(m, botId());
    if (!place) return;
    await withAssets(async (assets) => {
    if (place.threadId && !getThread(place.threadId) && m.channel.isThread()) {
      const t = m.channel;
      const all = [...(await t.messages.fetch({ limit: 100 })).values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      rememberDiscordMessages(all.map((x) => linkOf(x, place.conversationId)));
      await importThreadMessages({
        thread: { id: t.id, name: t.name, parentId: t.parentId ?? "" },
        messages: all.map(toDceMessage),
        noticeId: null,
        rows,
        assets,
        progress,
        warn,
        flush: async (batch) => void insertImportedMessages(batch),
      });
    } else {
      const row = await rows.buildRow(toDceMessage(m), assets, place.conversationId, place.discordChannelId, place.threadId);
      if (!row || insertImportedMessages([row]) === 0) return;
      rememberDiscordMessages([linkOf(m, place.conversationId)]);
      if (place.threadId) refreshImportedThreadCounters(place.threadId);
    }
    const stored = await getMessageById(place.conversationId, importedId("message", m.id));
    if (!stored) return;
    const shown = await view(stored);
    appendCachedMessage(place.conversationId, shown);
    await emit(place.conversationId, "chat:new", { ...shown, created_at: stored.created_at.toISOString() });
    });
  }));

  c.on(Events.MessageUpdate, guarded("edit", async (before: Message | PartialMessage, after: Message | PartialMessage) => {
    const m = after.partial ? await after.fetch() : after;
    const place = await placeOf(m, botId());
    if (!place) return;
    const id = importedId("message", m.id);
    if (before.partial || before.content !== m.content) {
      const row = await withAssets((assets) => rows.buildRow(toDceMessage(m), assets, place.conversationId, place.discordChannelId, place.threadId));
      const updated = row?.text ? await updateMessageText(place.conversationId, id, row.text) : null;
      if (updated) {
        replaceCachedMessage(place.conversationId, updated);
        await emit(place.conversationId, "chat:edited", await view(updated));
      }
    }
    if (before.partial || before.pinned !== m.pinned) {
      const updated = await setMessagePinned(place.conversationId, id, m.pinned ? discordSenderId("0") : null);
      if (updated) {
        replaceCachedMessage(place.conversationId, updated);
        await emit(place.conversationId, "chat:pinned", { conversation_id: place.conversationId, message_id: id, pinned_at: updated.pinned_at ?? null, pinned_by: updated.pinned_by ?? null });
      }
    }
  }));

  c.on(Events.MessageDelete, guarded("delete", async (m: Message | PartialMessage) => {
    const place = await placeOf(m, botId());
    const refs = pluginRefs();
    if (!place || !refs) return;
    const id = importedId("message", m.id);
    const message = await getMessageById(place.conversationId, id);
    if (!message) return;
    await deleteMessageEverywhere({ io: refs.io, clientsInfo: refs.clientsInfo, sfuClient: refs.sfuClient, conversationId: place.conversationId, messageId: id, message, access: CHANNEL_ACCESS });
  }));

  const react = (add: boolean) =>
    guarded(add ? "reaction" : "reaction removal", async (r: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      if (user.id === botId()) return;
      const place = await placeOf(r.message, botId());
      const src = reactionSrc(r);
      if (!place || !src) return;
      const id = importedId("message", r.message.id);
      const write = add ? addReactionToMessage : removeReactionFromMessage;
      const updated = await write(place.conversationId, id, src, discordSenderId(user.id));
      if (!updated) return;
      replaceCachedMessage(place.conversationId, updated);
      await emit(place.conversationId, "chat:reaction", await view(updated));
    });
  c.on(Events.MessageReactionAdd, react(true));
  c.on(Events.MessageReactionRemove, react(false));
}
