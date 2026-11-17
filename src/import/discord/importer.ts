import { readFile, stat } from "node:fs/promises";
import { basename, posix, relative, sep } from "node:path";

import {
  addChannelRowIfMissing,
  moveChannelRowToEnd,
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
} from "../../db";
import { clip } from "./content";
import {
  DM_TYPES,
  IMPORTED_MESSAGE_TYPES,
  isSnowflake,
  THREAD_TYPES,
  VOICE_TYPES,
  type DceExport,
  type DceMessage,
} from "./dce";
import { indexExportFolder, readExportHead, resolveExportAsset, type ExportFolder } from "./exportFolder";
import { folderItemId, importedId } from "./ids";
import { DiscordRowBuilder, type AssetSource } from "./rows";

function channelKind(type: string | undefined): "text" | "voice" | "forum" {
  if (VOICE_TYPES.has(type ?? "")) return "voice";
  return type === "GuildForum" ? "forum" : "text";
}

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

export interface ChannelPlan {
  id: string;
  /** The owner matched it to a channel that's already here. */
  grytChannelId?: string;
  name: string;
  kind: "text" | "voice" | "forum";
  topic: string | null;
  categoryId: string | null;
  categoryName: string | null;
}

interface PlannedChannel extends ChannelPlan {
  files: ChannelFile[];
}

interface PlannedThread {
  id: string;
  name: string;
  parentId: string;
  files: ChannelFile[];
}

/** Only what's missing. A channel the owner renamed or moved after an earlier run stays as they left it. */
export async function createImportedChannels(channels: Iterable<ChannelPlan>): Promise<void> {
  const existing = await listServerChannels();
  let position = existing.reduce((max, c) => Math.max(max, c.position), 0) + 1;
  const items = await listServerSidebarItems();
  const folders = new Set(items.filter((i) => i.kind === "folder").map((i) => i.item_id));
  let sidebarEnd = items.reduce((max, i) => Math.max(max, i.position), 0) + 10;

  for (const c of channels) {
    const channelId = c.grytChannelId ?? importedId("channel", c.id);
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
    if (c.grytChannelId && c.grytChannelId !== importedId("channel", c.id)) await moveChannelRowToEnd(channelId, parentItem);
    else await addChannelRowIfMissing(channelId, parentItem);
  }
}


export interface ThreadCopy {
  /** `conversationId` when the parent was matched to a channel that's already here. */
  thread: { id: string; name: string; parentId: string; conversationId?: string };
  /** Oldest first. */
  messages: DceMessage[];
  /** The parent's ThreadCreated notice, when there is one. */
  noticeId: string | null;
  rows: DiscordRowBuilder;
  assets: AssetSource;
  progress: DiscordImportProgress;
  warn: (message: string) => void;
  flush: (batch: ImportedMessageRow[]) => Promise<void>;
}

/** One thread into its parent channel: the root found or made, then the replies. Safe to rerun. */
export async function importThreadMessages(opts: ThreadCopy): Promise<void> {
  const { thread, messages } = opts;
  const conversationId = thread.conversationId ?? importedId("channel", thread.parentId);
  // Discord gives a thread started from a message that message's id. Otherwise
  // the parent has a ThreadCreated notice, or, for forum posts, nothing at all.
  let rootDiscordId: string | null = null;
  if (importedMessageExists(conversationId, importedId("message", thread.id))) rootDiscordId = thread.id;
  else {
    const notice = opts.noticeId;
    if (notice && importedMessageExists(conversationId, importedId("message", notice))) rootDiscordId = notice;
  }

  let replies = messages;
  let rootRow: ImportedMessageRow | null = null;
  if (!rootDiscordId) {
    // The thread's first message goes into the parent as the root.
    const index = messages.findIndex((m) => IMPORTED_MESSAGE_TYPES.has(m?.type ?? "") && isSnowflake(m?.id));
    if (index === -1) {
      opts.warn(`Thread "${thread.name}" has no messages to import.`);
      return;
    }
    const root = messages[index];
    rootRow = await opts.rows.buildRow(root, opts.assets, conversationId, thread.id, null);
    if (!rootRow || !root.id) return;
    await opts.flush([rootRow]);
    rootDiscordId = root.id;
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
      opts.progress.messages_already_there += 1;
      continue;
    }
    const row = await opts.rows.buildRow(msg, opts.assets, conversationId, thread.id, threadId);
    if (!row) continue;
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await opts.flush(batch);
      batch = [];
    }
  }
  await opts.flush(batch);
  refreshImportedThreadCounters(threadId);
}

export function emptyProgress(): DiscordImportProgress {
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


class DiscordImport {
  readonly progress = emptyProgress();
  readonly warnings: string[] = [];
  private folder!: ExportFolder;
  private readonly channels = new Map<string, PlannedChannel>();
  private readonly threads = new Map<string, PlannedThread>();
  private readonly channelNames = new Map<string, string>();
  /** ThreadCreated notices by the thread they announce, filled while parents import. */
  private readonly threadNotices = new Map<string, string>();
  private readonly rows: DiscordRowBuilder;

  constructor(private readonly opts: ImportOptions) {
    this.rows = new DiscordRowBuilder(opts.media, this.progress, (m) => this.warn(m), this.channelNames);
  }

  private assets(file: ChannelFile): AssetSource {
    return {
      missingNote: "not in the export",
      resolve: async (ref) => {
        const path = resolveExportAsset(this.folder, file.relDir, ref);
        return path ? { path, key: relative(this.folder.root, path).split(sep).join("/") } : null;
      },
    };
  }

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
    await this.rows.queueEmojis(this.opts.startedBy);
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
        if (!this.channelNames.has(ch.categoryId) && ch.category) this.channelNames.set(ch.categoryId, clip(ch.category, 80) ?? ch.category);
        continue;
      }

      const planned = this.channels.get(ch.id) ?? {
        id: ch.id,
        name,
        kind: channelKind(ch.type),
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

  private async createChannels(): Promise<void> {
    await createImportedChannels(this.channels.values());
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
        const row = await this.rows.buildRow(msg, this.assets(file), conversationId, channel.id, null);
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
    const messages: DceMessage[] = [];
    for (const file of thread.files) {
      for (const m of await this.readChannelFile(file)) messages.push(m);
    }
    await importThreadMessages({
      thread,
      messages,
      noticeId: this.threadNotices.get(thread.id) ?? null,
      rows: this.rows,
      assets: this.assets(thread.files[0]),
      progress: this.progress,
      warn: (m) => this.warn(m),
      flush: (batch) => this.flush(batch),
    });
  }

  private async flush(batch: ImportedMessageRow[]): Promise<void> {
    if (batch.length === 0) return;
    const inserted = insertImportedMessages(batch);
    this.progress.messages_imported += inserted;
    this.progress.messages_already_there += batch.length - inserted;
    await this.report();
  }

}

/** Imports every DCE JSON file under `root`. Safe to run again: it only adds what isn't there. */
export async function importDiscordExport(opts: ImportOptions): Promise<ImportResult> {
  return new DiscordImport(opts).run();
}
