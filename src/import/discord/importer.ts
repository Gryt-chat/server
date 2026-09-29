import { readFile, stat } from "node:fs/promises";
import { basename, posix, relative, sep } from "node:path";

import {
  addChannelRowIfMissing,
  ensureImportedThread,
  getMessageById,
  getServerChannel,
  importedMessageExists,
  insertImportedMessages,
  listServerChannels,
  listServerSidebarItems,
  refreshImportedThreadCounters,
  upsertServerChannel,
  upsertServerSidebarItem,
  type DiscordImportProgress,
  type ImportedMessageRow,
  type Reaction,
  type StoredWebhookCard,
} from "../../db";
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
import {
  DM_TYPES,
  IMPORTED_MESSAGE_TYPES,
  isSnowflake,
  THREAD_TYPES,
  VOICE_TYPES,
  type DceEmbed,
  type DceExport,
  type DceMessage,
} from "./dce";
import { indexExportFolder, readExportHead, resolveExportAsset, type ExportFolder } from "./exportFolder";
import { discordSenderId, folderItemId, importedId } from "./ids";

/** `JSON.parse` holds the whole file as one string. DCE's `--partition` keeps files under this. */
export const MAX_CHANNEL_FILE_BYTES = 256 * 1024 * 1024;
const BATCH_SIZE = 250;

export type StoreOutcome = { kind: "stored" } | { kind: "exists" } | { kind: "skipped"; reason: string };

/** Where the bytes go. The real one stores through the upload path; tests pass their own. */
export interface ImportMedia {
  storeFile(input: { fileId: string; path: string; originalName: string; uploadedBy: string; imageOnly?: boolean }): Promise<StoreOutcome>;
  /** False when the name is taken or already queued: an import never replaces a server's emoji. */
  queueEmoji(input: { name: string; path: string; uploadedBy: string }): Promise<boolean>;
}

export interface ImportOptions {
  root: string;
  /** Who queued the emoji. Messages and files are attributed to their Discord authors. */
  startedBy: string;
  media: ImportMedia;
  onProgress?: (progress: DiscordImportProgress, warnings: string[]) => Promise<void> | void;
}

export interface ImportResult {
  progress: DiscordImportProgress;
  warnings: string[];
}

interface ChannelFile {
  path: string;
  /** Directory of the JSON relative to the root, for resolving DCE's relative media paths. */
  relDir: string;
  part: number;
}

interface PlannedChannel {
  id: string;
  name: string;
  kind: "text" | "voice" | "forum";
  topic: string | null;
  categoryId: string | null;
  categoryName: string | null;
  files: ChannelFile[];
}

interface PlannedThread {
  id: string;
  name: string;
  parentId: string;
  files: ChannelFile[];
}

function emptyProgress(): DiscordImportProgress {
  return {
    channels_total: 0, channels_done: 0, messages_imported: 0, messages_already_there: 0,
    messages_skipped: 0, files_stored: 0, files_already_there: 0, files_skipped: 0,
    files_missing: 0, emojis_queued: 0, current_channel: null,
  };
}

function partOf(fileName: string): number {
  const m = / \[part (\d+)\]\.json$/i.exec(fileName);
  return m ? Number(m[1]) : 1;
}

function asDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

class DiscordImport {
  readonly progress = emptyProgress();
  readonly warnings: string[] = [];
  private folder!: ExportFolder;
  private readonly channels = new Map<string, PlannedChannel>();
  private readonly threads = new Map<string, PlannedThread>();
  private readonly channelNames = new Map<string, string>();
  /** ThreadCreated notices by the thread they announce, filled while parents import. */
  private readonly threadNotices = new Map<string, string>();
  /** A file is stored once per run, whichever message names it. */
  private readonly stored = new Map<string, boolean>();
  private readonly emojis = new Map<string, string>();

  constructor(private readonly opts: ImportOptions) {}

  warn(message: string): void {
    if (this.warnings.length < 200) this.warnings.push(message);
  }

  async run(): Promise<ImportResult> {
    this.folder = await indexExportFolder(this.opts.root);
    await this.plan();
    await this.report();
    await this.createChannels();

    for (const channel of this.channels.values()) {
      if (channel.files.length > 0) await this.importChannel(channel);
      this.progress.channels_done += 1;
      await this.report();
    }
    for (const thread of this.threads.values()) {
      await this.importThread(thread);
      this.progress.channels_done += 1;
      await this.report();
    }
    await this.queueEmojis();
    this.progress.current_channel = null;
    await this.report();
    return { progress: this.progress, warnings: this.warnings };
  }

  private async report(): Promise<void> {
    await this.opts.onProgress?.({ ...this.progress }, [...this.warnings]);
  }

  private async plan(): Promise<void> {
    const jsonFiles = [...this.folder.files.entries()].filter(([rel]) => rel.toLowerCase().endsWith(".json")).sort(([a], [b]) => a.localeCompare(b));
    for (const [rel, path] of jsonFiles) {
      // A file that isn't DCE's indented layout has no head to read, so it's parsed whole.
      const head = ((await readExportHead(path)) ?? (await this.parseWhole(path))) as DceExport | null;
      const ch = head?.channel;
      if (!head || !ch || !isSnowflake(ch.id) || !head.guild) continue;
      if (DM_TYPES.has(ch.type ?? "")) {
        this.warn(`${rel}: a DM export. DMs are end-to-end encrypted in Gryt, so they're imported by the app, not the server.`);
        continue;
      }
      const file: ChannelFile = { path, relDir: posix.dirname(rel), part: partOf(basename(rel)) };
      const name = clip(ch.name, 80) ?? `channel-${ch.id}`;
      this.channelNames.set(ch.id, name);

      if (THREAD_TYPES.has(ch.type ?? "")) {
        if (!isSnowflake(ch.categoryId)) {
          this.warn(`${rel}: a thread with no parent channel, skipped.`);
          continue;
        }
        const t = this.threads.get(ch.id) ?? { id: ch.id, name, parentId: ch.categoryId, files: [] };
        t.files.push(file);
        this.threads.set(ch.id, t);
        if (!this.channelNames.has(ch.categoryId) && ch.category) this.channelNames.set(ch.categoryId, clip(ch.category, 80)!);
        continue;
      }

      const planned = this.channels.get(ch.id) ?? {
        id: ch.id,
        name,
        kind: VOICE_TYPES.has(ch.type ?? "") ? "voice" : ch.type === "GuildForum" ? "forum" : "text",
        topic: clip(ch.topic, 200) ?? null,
        categoryId: isSnowflake(ch.categoryId) ? ch.categoryId : null,
        categoryName: clip(ch.category, 80) ?? null,
        files: [],
      };
      planned.files.push(file);
      this.channels.set(ch.id, planned);
    }

    // A thread's parent that wasn't exported is a forum: DCE exports forum posts but never the forum.
    for (const t of this.threads.values()) {
      if (this.channels.has(t.parentId)) continue;
      this.channels.set(t.parentId, {
        id: t.parentId,
        name: this.channelNames.get(t.parentId) ?? `forum-${t.parentId}`,
        kind: "forum",
        topic: null,
        categoryId: null,
        categoryName: null,
        files: [],
      });
    }
    for (const c of this.channels.values()) c.files.sort((a, b) => a.part - b.part);
    for (const t of this.threads.values()) t.files.sort((a, b) => a.part - b.part);
    this.progress.channels_total = this.channels.size + this.threads.size;
    if (this.progress.channels_total === 0) throw new Error("No DiscordChatExporter JSON files were found in that folder.");
  }

  /** Only what's missing. A channel the owner renamed or moved after an earlier run stays as they left it. */
  private async createChannels(): Promise<void> {
    const existing = await listServerChannels();
    let position = existing.reduce((max, c) => Math.max(max, c.position), 0) + 1;
    const items = await listServerSidebarItems();
    const folders = new Set(items.filter((i) => i.kind === "folder").map((i) => i.item_id));
    let sidebarEnd = items.reduce((max, i) => Math.max(max, i.position), 0) + 10;

    for (const c of this.channels.values()) {
      const channelId = importedId("channel", c.id);
      let parentItem: string | null = null;
      if (c.categoryId) {
        parentItem = folderItemId(c.categoryId);
        if (!folders.has(parentItem)) {
          await upsertServerSidebarItem({ itemId: parentItem, kind: "folder", label: c.categoryName ?? "Discord", position: sidebarEnd });
          sidebarEnd += 10;
          folders.add(parentItem);
        }
      }
      if (!(await getServerChannel(channelId))) {
        await upsertServerChannel({
          channelId,
          name: c.name,
          type: c.kind === "voice" ? "voice" : "text",
          position: position++,
          description: c.topic,
          textInVoice: c.kind === "voice",
          layout: c.kind === "forum" ? "forum" : "chat",
        });
      }
      await addChannelRowIfMissing(channelId, parentItem);
    }
  }

  private async parseWhole(path: string): Promise<DceExport | null> {
    const info = await stat(path);
    if (info.size > MAX_CHANNEL_FILE_BYTES) return null;
    try {
      return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as DceExport;
    } catch {
      return null;
    }
  }

  private async readChannelFile(file: ChannelFile): Promise<DceMessage[]> {
    const info = await stat(file.path);
    if (info.size > MAX_CHANNEL_FILE_BYTES) {
      this.warn(`${basename(file.path)} is over ${MAX_CHANNEL_FILE_BYTES / 1024 / 1024} MB. Export it again with --partition 10000 and rerun.`);
      return [];
    }
    let parsed: DceExport;
    try {
      parsed = JSON.parse((await readFile(file.path, "utf8")).replace(/^\uFEFF/, "")) as DceExport;
    } catch {
      this.warn(`${basename(file.path)} isn't valid JSON, skipped.`);
      return [];
    }
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  }

  private async importChannel(channel: PlannedChannel): Promise<void> {
    this.progress.current_channel = channel.name;
    const conversationId = importedId("channel", channel.id);
    for (const file of channel.files) {
      const messages = await this.readChannelFile(file);
      let batch: ImportedMessageRow[] = [];
      for (const msg of messages) {
        if (msg?.type === "ThreadCreated" && isSnowflake(msg.reference?.channelId) && isSnowflake(msg.id)) {
          this.threadNotices.set(msg.reference.channelId, msg.id);
        }
        const row = await this.buildRow(msg, file, conversationId, channel.id, null);
        if (!row) continue;
        batch.push(row);
        if (batch.length >= BATCH_SIZE) {
          await this.flush(batch);
          batch = [];
        }
      }
      await this.flush(batch);
    }
  }

  private async importThread(thread: PlannedThread): Promise<void> {
    this.progress.current_channel = thread.name;
    const conversationId = importedId("channel", thread.parentId);
    const messages: DceMessage[] = [];
    for (const file of thread.files) {
      for (const m of await this.readChannelFile(file)) messages.push(m);
    }
    const file = thread.files[0];

    // Discord gives a thread started from a message that message's id. Otherwise
    // the parent has a ThreadCreated notice, or, for forum posts, nothing at all.
    let rootDiscordId: string | null = null;
    if (importedMessageExists(conversationId, importedId("message", thread.id))) rootDiscordId = thread.id;
    else {
      const notice = this.threadNotices.get(thread.id);
      if (notice && importedMessageExists(conversationId, importedId("message", notice))) rootDiscordId = notice;
    }

    let replies = messages;
    let rootRow: ImportedMessageRow | null = null;
    if (!rootDiscordId) {
      // The thread's first message goes into the parent as the root.
      const index = messages.findIndex((m) => IMPORTED_MESSAGE_TYPES.has(m?.type ?? "") && isSnowflake(m?.id));
      if (index === -1) {
        this.warn(`Thread "${thread.name}" has no messages to import.`);
        return;
      }
      rootRow = await this.buildRow(messages[index], file, conversationId, thread.id, null);
      if (!rootRow) return;
      await this.flush([rootRow]);
      rootDiscordId = messages[index].id!;
      replies = messages.slice(index + 1);
    }

    const rootId = importedId("message", rootDiscordId);
    const root = rootRow ?? (await getMessageById(conversationId, rootId));
    const threadId = ensureImportedThread({
      thread_id: importedId("thread", thread.id),
      conversation_id: conversationId,
      root_message_id: rootId,
      title: thread.name,
      created_by: root?.sender_server_id ?? "system",
      created_at: root?.created_at ?? new Date(),
    });

    let batch: ImportedMessageRow[] = [];
    for (const msg of replies) {
      if (msg?.id === rootDiscordId) {
        // A forum post's first message, put into the forum as the root on an earlier run.
        this.progress.messages_already_there += 1;
        continue;
      }
      const row = await this.buildRow(msg, file, conversationId, thread.id, threadId);
      if (!row) continue;
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        await this.flush(batch);
        batch = [];
      }
    }
    await this.flush(batch);
    refreshImportedThreadCounters(threadId);
  }

  private async flush(batch: ImportedMessageRow[]): Promise<void> {
    if (batch.length === 0) return;
    const inserted = insertImportedMessages(batch);
    this.progress.messages_imported += inserted;
    this.progress.messages_already_there += batch.length - inserted;
    await this.report();
  }

  /** Stores a file once per run under a derived id, keyed by its path when `key` is null.
      Returns the id, or a note saying why it's absent. */
  private async store(
    key: string | null,
    kind: "file" | "avatar" | "sticker",
    ref: string | null | undefined,
    file: ChannelFile,
    originalName: string,
    uploadedBy: string,
    imageOnly = false,
  ): Promise<{ fileId: string } | { note: string }> {
    const path = resolveExportAsset(this.folder, file.relDir, ref);
    if (!path) {
      this.progress.files_missing += 1;
      return { note: "not in the export" };
    }
    const fileId = importedId(kind, key ?? relative(this.folder.root, path).split(sep).join("/"));
    const known = this.stored.get(fileId);
    if (known === true) return { fileId };
    if (known === false) return { note: "couldn't be stored" };

    const outcome = await this.opts.media.storeFile({ fileId, path, originalName, uploadedBy, imageOnly });
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

  private async buildRow(
    msg: DceMessage,
    file: ChannelFile,
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
      const stored = await this.store(null, "avatar", author.avatarUrl, file, `${authorId}.png`, sender, true);
      if ("fileId" in stored) {
        avatarFileId = stored.fileId;
        media.push(stored.fileId);
      }
    }

    const allAttachments = [...(msg.attachments ?? []), ...(msg.forwardedMessage?.attachments ?? [])];
    for (const a of allAttachments) {
      const name = clip(a?.fileName, 255) ?? "file";
      const key = isSnowflake(a?.id) ? a.id : `${msg.id}:${a?.url ?? name}`;
      const stored = await this.store(key, "file", a?.url, file, name, sender);
      if ("fileId" in stored) attachments.push(stored.fileId);
      else notes.push(`*(${name} wasn't imported: ${stored.note})*`);
    }

    for (const s of msg.stickers ?? []) {
      const name = clip(s?.name, 64) ?? "sticker";
      if (s?.format === "Lottie") {
        notes.push(`*(sticker: ${name})*`);
        continue;
      }
      const stored = await this.store(isSnowflake(s?.id) ? s.id : `${msg.id}:${name}`, "sticker", s?.sourceUrl, file, `${name}.png`, sender, true);
      if ("fileId" in stored) attachments.push(stored.fileId);
      else notes.push(`*(sticker: ${name})*`);
    }

    const cards: StoredWebhookCard[] = [];
    for (const embed of msg.embeds ?? []) {
      if (!embed || isLinkPreview(embed, content) || !hasCardContent(embed) || cards.length >= L.cards) continue;
      const card = await this.buildCard(embed, file, sender);
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
        this.noteEmoji(name, e.imageUrl, file);
      }
      const users = (r.users ?? []).filter((u) => isSnowflake(u?.id)).map((u) => discordSenderId(u.id!));
      reactions.push({ src, amount: Math.max(users.length, Number(r.count) || 0), users });
    }
    for (const e of msg.inlineEmojis ?? []) {
      const name = isSnowflake(e?.id) ? emojiName(e.name) : null;
      if (name) this.noteEmoji(name, e.imageUrl, file);
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

  private async buildCard(embed: DceEmbed, file: ChannelFile, sender: string): Promise<StoredWebhookCard> {
    const picture = async (ref: string | null | undefined): Promise<string | undefined> => {
      if (!ref) return undefined;
      const stored = await this.store(null, "file", ref, file, basename(ref.replace(/\\/g, "/")) || "image", sender, true);
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

  private noteEmoji(name: string, ref: string | null | undefined, file: ChannelFile): void {
    if (this.emojis.has(name)) return;
    const path = resolveExportAsset(this.folder, file.relDir, ref);
    if (path) this.emojis.set(name, path);
  }

  private async queueEmojis(): Promise<void> {
    for (const [name, path] of this.emojis) {
      if (await this.opts.media.queueEmoji({ name, path, uploadedBy: this.opts.startedBy })) {
        this.progress.emojis_queued += 1;
      }
    }
  }
}

/** Imports every DCE JSON file under `root`. Safe to run again: it only adds what isn't there. */
export async function importDiscordExport(opts: ImportOptions): Promise<ImportResult> {
  return new DiscordImport(opts).run();
}
