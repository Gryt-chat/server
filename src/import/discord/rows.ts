import { basename } from "node:path";

import type { DiscordImportProgress, ImportedMessageRow, Reaction, StoredWebhookCard } from "../../db";
import { WEBHOOK_LIMITS as L } from "../../routes/webhookSchemas";
import {
  authorName,
  clip,
  composeText,
  emojiName,
  hasCardContent,
  httpUrl,
  isLinkPreview,
  normaliseHexColor,
  rewriteDiscordMarkup,
} from "./content";
import { IMPORTED_MESSAGE_TYPES, isSnowflake, type DceEmbed, type DceMessage } from "./dce";
import { discordSenderId, importedId } from "./ids";
import type { ImportMedia } from "./importer";

/** Where a message's files come from: an export folder, or Discord itself. `key` names a file with no id of its own. */
export interface AssetSource {
  resolve(ref: string | null | undefined): Promise<{ path: string; key: string } | null>;
  missingNote: string;
}

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Turns one Discord message into a Gryt row, storing its files once per run. */
export class DiscordRowBuilder {
  /** A file is stored once per run, whichever message names it. */
  private readonly stored = new Map<string, boolean>();
  private readonly emojis = new Map<string, string>();

  constructor(
    private readonly media: ImportMedia,
    private readonly progress: DiscordImportProgress,
    private readonly warn: (message: string) => void,
    private readonly channelNames: Map<string, string>,
  ) {}

  /** Stores a file once per run under a derived id, keyed by its path when `key` is null.
      Returns the id, or a note saying why it's absent. */
  private async store(
    key: string | null,
    kind: "file" | "avatar" | "sticker",
    ref: string | null | undefined,
    assets: AssetSource,
    originalName: string,
    uploadedBy: string,
    imageOnly = false,
  ): Promise<{ fileId: string } | { note: string }> {
    const found = await assets.resolve(ref);
    if (!found) {
      this.progress.files_missing += 1;
      return { note: assets.missingNote };
    }
    const { path } = found;
    const fileId = importedId(kind, key ?? found.key);
    const known = this.stored.get(fileId);
    if (known === true) return { fileId };
    if (known === false) return { note: "couldn't be stored" };

    const outcome = await this.media.storeFile({ fileId, path, originalName, uploadedBy, imageOnly });
    if (outcome.kind === "skipped") {
      this.stored.set(fileId, false);
      this.progress.files_skipped += 1;
      this.warn(`${originalName}: ${outcome.reason}`);
      return { note: outcome.reason };
    }
    this.stored.set(fileId, true);
    if (outcome.kind === "stored") this.progress.files_stored += 1;
    else this.progress.files_already_there += 1;
    return { fileId };
  }

  /** A Discord person's current picture, stored like the ones on their messages. */
  async avatar(url: string, authorId: string, assets: AssetSource): Promise<string | null> {
    const stored = await this.store(null, "avatar", url, assets, `${authorId}.png`, discordSenderId(authorId), true);
    return "fileId" in stored ? stored.fileId : null;
  }

  async buildRow(
    msg: DceMessage,
    assets: AssetSource,
    conversationId: string,
    discordChannelId: string,
    threadId: string | null,
  ): Promise<ImportedMessageRow | null> {
    const createdAt = asDate(msg?.timestamp);
    if (!msg || !isSnowflake(msg.id) || !createdAt || !IMPORTED_MESSAGE_TYPES.has(msg.type ?? "")) {
      this.progress.messages_skipped += 1;
      return null;
    }
    const author = msg.author;
    const authorId = isSnowflake(author?.id) ? author.id : "0";
    const sender = discordSenderId(authorId);
    const content = typeof msg.content === "string" ? msg.content : "";
    const notes: string[] = [];
    const attachments: string[] = [];
    const media: string[] = [];

    let avatarFileId: string | null = null;
    if (author?.avatarUrl) {
      const stored = await this.store(null, "avatar", author.avatarUrl, assets, `${authorId}.png`, sender, true);
      if ("fileId" in stored) {
        avatarFileId = stored.fileId;
        media.push(stored.fileId);
      }
    }

    const allAttachments = [...(msg.attachments ?? []), ...(msg.forwardedMessage?.attachments ?? [])];
    for (const a of allAttachments) {
      const name = clip(a?.fileName, 255) ?? "file";
      const key = isSnowflake(a?.id) ? a.id : `${msg.id}:${a?.url ?? name}`;
      const stored = await this.store(key, "file", a?.url, assets, name, sender);
      if ("fileId" in stored) attachments.push(stored.fileId);
      else notes.push(`*(${name} wasn't imported: ${stored.note})*`);
    }

    for (const s of msg.stickers ?? []) {
      const name = clip(s?.name, 64) ?? "sticker";
      if (s?.format === "Lottie") {
        notes.push(`*(sticker: ${name})*`);
        continue;
      }
      const stored = await this.store(isSnowflake(s?.id) ? s.id : `${msg.id}:${name}`, "sticker", s?.sourceUrl, assets, `${name}.png`, sender, true);
      if ("fileId" in stored) attachments.push(stored.fileId);
      else notes.push(`*(sticker: ${name})*`);
    }

    const cards: StoredWebhookCard[] = [];
    for (const embed of msg.embeds ?? []) {
      if (!embed || isLinkPreview(embed, content) || !hasCardContent(embed) || cards.length >= L.cards) continue;
      const card = await this.buildCard(embed, assets, sender);
      cards.push(card);
      for (const id of [card.author?.icon_file_id, card.image_file_id, card.thumbnail_file_id, card.footer?.icon_file_id]) {
        if (id) media.push(id);
      }
    }

    const reactions: Reaction[] = [];
    for (const r of msg.reactions ?? []) {
      const e = r?.emoji;
      if (!e?.name) continue;
      let src = e.name;
      if (isSnowflake(e.id)) {
        const name = emojiName(e.name);
        if (!name) continue;
        src = `:${name}:`;
        await this.noteEmoji(name, e.imageUrl, assets);
      }
      const users = (r.users ?? []).flatMap((u) => (isSnowflake(u?.id) ? [discordSenderId(u.id)] : []));
      reactions.push({ src, amount: Math.max(users.length, Number(r.count) || 0), users });
    }
    for (const e of msg.inlineEmojis ?? []) {
      const name = isSnowflake(e?.id) ? emojiName(e.name) : null;
      if (name) await this.noteEmoji(name, e.imageUrl, assets);
    }

    let body = rewriteDiscordMarkup(content, msg.mentions, this.channelNames);
    const forwarded = msg.forwardedMessage?.content;
    if (typeof forwarded === "string" && forwarded.trim()) {
      const quoted = rewriteDiscordMarkup(forwarded, msg.mentions, this.channelNames).split("\n").map((l) => `> ${l}`).join("\n");
      body = [body, "*Forwarded:*", quoted].filter((p) => p.trim()).join("\n");
    }
    if (msg.type === "ThreadCreated" && !body.trim()) body = "*Started a thread.*";

    const text = composeText(body, notes);
    if (!text && attachments.length === 0 && cards.length === 0) {
      this.progress.messages_skipped += 1;
      return null;
    }

    const ref = msg.reference;
    const replyTo =
      msg.type === "Reply" && isSnowflake(ref?.messageId) && (!ref.channelId || ref.channelId === discordChannelId)
        ? importedId("message", ref.messageId)
        : null;

    return {
      conversation_id: conversationId,
      message_id: importedId("message", msg.id),
      sender_server_id: sender,
      sender_display_name: authorName(author),
      sender_avatar_file_id: avatarFileId,
      text,
      attachments,
      reactions,
      cards,
      reply_to_message_id: replyTo,
      thread_id: threadId,
      created_at: createdAt,
      edited_at: asDate(msg.timestampEdited),
      media_file_ids: media,
    };
  }

  private async buildCard(embed: DceEmbed, assets: AssetSource, sender: string): Promise<StoredWebhookCard> {
    const picture = async (ref: string | null | undefined): Promise<string | undefined> => {
      if (!ref) return undefined;
      const stored = await this.store(null, "file", ref, assets, basename(ref.replace(/\\/g, "/")) || "image", sender, true);
      return "fileId" in stored ? stored.fileId : undefined;
    };
    const card: StoredWebhookCard = {};
    const title = clip(embed.title, L.title);
    if (title) card.title = title;
    const url = httpUrl(embed.url);
    if (url) card.url = url;
    const description = clip(embed.description, L.description);
    if (description) card.description = description;
    const color = normaliseHexColor(embed.color);
    if (color) card.color = color;
    const authorNameText = clip(embed.author?.name, L.authorName);
    if (authorNameText) {
      const icon = await picture(embed.author?.iconUrl);
      const authorUrl = httpUrl(embed.author?.url);
      card.author = { name: authorNameText, ...(authorUrl ? { url: authorUrl } : {}), ...(icon ? { icon_file_id: icon } : {}) };
    }
    const fields = (embed.fields ?? [])
      .map((f) => ({ name: clip(f?.name, L.fieldName), value: clip(f?.value, L.fieldValue), inline: !!f?.isInline }))
      .filter((f): f is { name: string; value: string; inline: boolean } => !!f.name && !!f.value)
      .slice(0, L.fields);
    if (fields.length > 0) card.fields = fields;
    const image = await picture(embed.image?.url ?? embed.images?.[0]?.url);
    if (image) card.image_file_id = image;
    const thumbnail = await picture(embed.thumbnail?.url);
    if (thumbnail) card.thumbnail_file_id = thumbnail;
    const footerText = clip(embed.footer?.text, L.footerText);
    if (footerText) {
      const icon = await picture(embed.footer?.iconUrl);
      card.footer = { text: footerText, ...(icon ? { icon_file_id: icon } : {}) };
    }
    const ts = asDate(embed.timestamp);
    if (ts) card.timestamp = ts.toISOString();
    return card;
  }

  private async noteEmoji(name: string, ref: string | null | undefined, assets: AssetSource): Promise<void> {
    if (this.emojis.has(name)) return;
    const found = await assets.resolve(ref);
    if (found) this.emojis.set(name, found.path);
  }

  async queueEmojis(startedBy: string): Promise<void> {
    for (const [name, path] of this.emojis) {
      if (await this.media.queueEmoji({ name, path, uploadedBy: startedBy })) {
        this.progress.emojis_queued += 1;
      }
    }
  }
}
