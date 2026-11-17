import consola from "consola";
import { WebhookClient, type Client, type TextChannel } from "discord.js";

import {
  discordChannelFor,
  discordMessageFor,
  getDiscordBridge,
  getFilesByIds,
  rememberDiscordMessages,
  saveDiscordChannelWebhook,
  type MessageRecord,
} from "../db";
import { DISCORD_SENDER_PREFIX } from "../import/discord/ids";
import { getObjectAsBuffer, uploadsFolder } from "../storage";

/** Discord's own limit for a message. */
const MAX_CONTENT = 2000;
/** Discord caps a webhook message at 10 files; anything bigger than this is linked instead of sent. */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type ClientGetter = () => Client | null;
let getClient: ClientGetter = () => null;
type Hook = Pick<WebhookClient, "send" | "editMessage" | "deleteMessage">;
let makeHook = (id: string, token: string): Hook => new WebhookClient({ id, token });

/** Tests post into a fake instead of Discord. */
export function setWebhookFactory(make: (id: string, token: string) => Hook): void {
  makeHook = make;
}

export function setOutboundClient(get: ClientGetter): void {
  getClient = get;
}

function sending(): boolean {
  const b = getDiscordBridge();
  return !!b && b.status === "linked" && (b.direction === "both" || b.direction === "to_discord");
}

/** Our own copies coming back from Discord would loop, and Discord's own messages are already there. */
function fromGryt(m: MessageRecord): boolean {
  return !m.sender_server_id.startsWith(DISCORD_SENDER_PREFIX);
}

async function webhookFor(grytChannelId: string): Promise<{ hook: Hook; discordChannelId: string } | null> {
  const ch = discordChannelFor(grytChannelId);
  const c = getClient();
  if (!ch || !c) return null;
  if (ch.webhook_id && ch.webhook_token) return { hook: makeHook(ch.webhook_id, ch.webhook_token), discordChannelId: ch.discord_channel_id };
  const channel = (await c.channels.fetch(ch.discord_channel_id)) as TextChannel | null;
  if (!channel || !("createWebhook" in channel)) return null;
  const made = await channel.createWebhook({ name: "Gryt" });
  if (!made.token) return null;
  saveDiscordChannelWebhook(ch.discord_channel_id, made.id, made.token);
  return { hook: makeHook(made.id, made.token), discordChannelId: ch.discord_channel_id };
}

async function replyLine(m: MessageRecord): Promise<string> {
  if (!m.reply_to_message_id) return "";
  const target = discordMessageFor(m.reply_to_message_id);
  if (!target) return "";
  const guild = getDiscordBridge()?.guild_id;
  return `> ↪ https://discord.com/channels/${guild}/${target.discord_channel_id}/${target.discord_message_id}\n`;
}

async function filesOf(m: MessageRecord): Promise<{ attachment: Buffer; name: string }[]> {
  const ids = Array.isArray(m.attachments) ? m.attachments.slice(0, MAX_FILES) : [];
  if (ids.length === 0) return [];
  const records = await getFilesByIds(ids);
  const out: { attachment: Buffer; name: string }[] = [];
  for (const id of ids) {
    const f = records.get(id);
    if (!f || (f.size ?? 0) > MAX_FILE_BYTES) continue;
    try {
      out.push({ attachment: await getObjectAsBuffer({ bucket: uploadsFolder(), key: f.s3_key }), name: f.original_name ?? "file" });
    } catch (e) {
      consola.warn(`[DiscordBridge] couldn't read ${id} to send it`, e);
    }
  }
  return out;
}

/** A Gryt message posted into the linked Discord channel, under the member's name. */
export async function messageCreated(m: MessageRecord & { sender_nickname?: string }): Promise<void> {
  if (!sending() || !fromGryt(m)) return;
  const threadId = m.thread_id ? discordChannelFor(m.thread_id)?.discord_channel_id : undefined;
  if (m.thread_id && !threadId) return;
  const target = await webhookFor(m.conversation_id);
  if (!target) return;
  const content = `${await replyLine(m)}${m.text ?? ""}`.slice(0, MAX_CONTENT);
  const files = await filesOf(m);
  if (!content.trim() && files.length === 0) return;
  const sent = await target.hook.send({
    content: content || undefined,
    username: (m.sender_nickname ?? "Gryt member").slice(0, 80),
    files,
    allowedMentions: { parse: [] },
    ...(threadId ? { threadId } : {}),
  });
  rememberDiscordMessages([{ gryt_message_id: m.message_id, gryt_conversation_id: m.conversation_id, discord_channel_id: threadId ?? target.discordChannelId, discord_message_id: sent.id, from_gryt: true }]);
}

export async function messageEdited(m: MessageRecord): Promise<void> {
  const link = discordMessageFor(m.message_id);
  if (!sending() || !link?.from_gryt) return;
  const target = await webhookFor(m.conversation_id);
  if (!target) return;
  const threadId = link.discord_channel_id !== target.discordChannelId ? link.discord_channel_id : undefined;
  await target.hook.editMessage(link.discord_message_id, { content: `${await replyLine(m)}${m.text ?? ""}`.slice(0, MAX_CONTENT), allowedMentions: { parse: [] }, ...(threadId ? { threadId } : {}) });
}

/** Deletes go both ways: ours through the webhook, a Discord person's by the bot. */
export async function messageDeleted(grytMessageId: string): Promise<void> {
  const link = discordMessageFor(grytMessageId);
  const c = getClient();
  if (!sending() || !link || !c) return;
  if (link.from_gryt) {
    const target = await webhookFor(link.gryt_conversation_id);
    const threadId = target && link.discord_channel_id !== target.discordChannelId ? link.discord_channel_id : undefined;
    await target?.hook.deleteMessage(link.discord_message_id, threadId);
    return;
  }
  const channel = (await c.channels.fetch(link.discord_channel_id)) as TextChannel | null;
  await channel?.messages.delete(link.discord_message_id);
}

export async function messagePinned(grytMessageId: string, pinned: boolean): Promise<void> {
  const link = discordMessageFor(grytMessageId);
  const c = getClient();
  if (!sending() || !link || !c) return;
  const channel = (await c.channels.fetch(link.discord_channel_id)) as TextChannel | null;
  const msg = await channel?.messages.fetch(link.discord_message_id);
  if (!msg || msg.pinned === pinned) return;
  await (pinned ? msg.pin() : msg.unpin());
}

/** Discord counts one reaction per account, so the bot holds an emoji while any Gryt member does. */
export async function reactionsChanged(m: MessageRecord): Promise<void> {
  const link = discordMessageFor(m.message_id);
  const c = getClient();
  if (!sending() || !link || !c) return;
  const channel = (await c.channels.fetch(link.discord_channel_id)) as TextChannel | null;
  const msg = await channel?.messages.fetch(link.discord_message_id);
  if (!msg) return;
  const wanted = new Set(
    (m.reactions ?? [])
      .filter((r) => r.users.some((u) => !u.startsWith(DISCORD_SENDER_PREFIX)))
      .map((r) => r.src)
      .filter((src) => !src.startsWith(":")),
  );
  const mine = new Set([...msg.reactions.cache.values()].filter((r) => r.me && r.emoji.name).map((r) => r.emoji.name as string));
  for (const e of wanted) if (!mine.has(e)) await msg.react(e);
  for (const e of mine) if (!wanted.has(e)) await msg.reactions.cache.find((r) => r.emoji.name === e)?.users.remove(c.user?.id);
}

/** Every hook is fire-and-forget: a slow or failing Discord never holds up a Gryt message. */
export function outbound<A extends object[]>(name: string, fn: (...a: A) => Promise<void>) {
  return (...a: A): void => {
    fn(...a).catch((e) => consola.warn(`[DiscordBridge] ${name} to Discord failed`, e));
  };
}

export const toDiscord = {
  created: outbound("message", messageCreated),
  edited: outbound("edit", messageEdited),
  deleted: (id: string) => void messageDeleted(id).catch((e) => consola.warn("[DiscordBridge] delete to Discord failed", e)),
  pinned: (id: string, pinned: boolean) => void messagePinned(id, pinned).catch((e) => consola.warn("[DiscordBridge] pin to Discord failed", e)),
  reactions: outbound("reaction", reactionsChanged),
};
