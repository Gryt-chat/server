import { randomUUID } from "crypto";

import type { StoredPoll } from "../../polls/poll";
import type { FileOwnership, FileRecord, MessageRecord, Reaction } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso, type SQLInputValue } from "./connection";

function rowToMessage(r: Record<string, unknown>): MessageRecord {
  return {
    conversation_id: r.conversation_id as string,
    message_id: r.message_id as string,
    sender_server_id: r.sender_server_id as string,
    text: (r.text as string) ?? null,
    sealed: (r.sealed as string) ?? null,
    created_at: fromIso(r.created_at as string),
    edited_at: fromIsoNullable(r.edited_at as string | null),
    attachments: r.attachments ? JSON.parse(r.attachments as string) : null,
    reactions: r.reactions ? JSON.parse(r.reactions as string) : null,
    reply_to_message_id: (r.reply_to_message_id as string) ?? null,
    thread_id: (r.thread_id as string) ?? null,
    // Only set when there is something, so a normal message's shape is unchanged.
    ...(r.cards ? { cards: JSON.parse(r.cards as string) } : {}),
    ...(r.text_fallback ? { text_fallback: true } : {}),
    ...(r.sender_display_name ? { sender_display_name: r.sender_display_name as string } : {}),
    ...(r.sender_avatar_file_id ? { sender_avatar_file_id: r.sender_avatar_file_id as string } : {}),
    ...(r.poll ? { poll: JSON.parse(r.poll as string) } : {}),
    ...(r.pinned_at ? { pinned_at: fromIso(r.pinned_at as string), pinned_by: (r.pinned_by as string) ?? null } : {}),
    ...(r.mls_seq != null
      ? { mls_placeholder: { seq: Number(r.mls_seq), sender_server_id: r.mls_sender_server_id as string } }
      : {}),
  };
}

/** `media_file_ids` are files the message shows without listing them as attachments, like a
    card's pictures. They get the same reference, so reads and the sweep treat them the same. */
export async function insertMessage(record: Omit<MessageRecord, "message_id" | "created_at"> & { created_at?: Date; message_id?: string; media_file_ids?: string[] }): Promise<MessageRecord> {
  const db = getSqliteDb();
  const created_at = record.created_at ?? new Date();
  const message_id = record.message_id ?? randomUUID();

  db.prepare(
    `INSERT INTO messages (conversation_id, message_id, sender_server_id, text, sealed, attachments, reactions, reply_to_message_id, thread_id, cards, text_fallback, sender_display_name, sender_avatar_file_id, mls_seq, mls_sender_server_id, poll, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.conversation_id,
    message_id,
    record.sender_server_id,
    record.text ?? null,
    record.sealed ?? null,
    record.attachments ? JSON.stringify(record.attachments) : null,
    record.reactions ? JSON.stringify(record.reactions) : null,
    record.reply_to_message_id ?? null,
    record.thread_id ?? null,
    record.cards && record.cards.length > 0 ? JSON.stringify(record.cards) : null,
    record.text_fallback ? 1 : 0,
    record.sender_display_name ?? null,
    record.sender_avatar_file_id ?? null,
    record.mls_placeholder?.seq ?? null,
    record.mls_placeholder?.sender_server_id ?? null,
    record.poll ? JSON.stringify(record.poll) : null,
    toIso(created_at),
  );

  const referenced = [...(record.attachments ?? []), ...(record.media_file_ids ?? [])];
  if (referenced.length > 0) {
    const ref = db.prepare(
      `INSERT OR IGNORE INTO message_attachments (file_id, conversation_id, message_id) VALUES (?, ?, ?)`,
    );
    for (const fileId of referenced) ref.run(fileId, record.conversation_id, message_id);
  }

  const stored: typeof record = { ...record };
  delete stored.media_file_ids;
  return { ...stored, created_at, message_id } as MessageRecord;
}

export async function listMessages(conversationId: string, limit = 50, before?: Date): Promise<MessageRecord[]> {
  const db = getSqliteDb();
  const rows = before
    ? db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND thread_id IS NULL AND created_at < ? ORDER BY created_at DESC, message_id DESC LIMIT ?`).all(conversationId, toIso(before), limit)
    : db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND thread_id IS NULL ORDER BY created_at DESC, message_id DESC LIMIT ?`).all(conversationId, limit);
  const messages = (rows as Record<string, unknown>[]).map(rowToMessage);
  messages.reverse();
  return messages;
}

/** Oldest-first from a point onwards: the newer half of a jump to an old message, and the pages
    below it until the window reaches the present (GRYT-1686). */
export async function listMessagesAfter(conversationId: string, limit: number, after: Date): Promise<MessageRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND thread_id IS NULL AND created_at > ? ORDER BY created_at ASC, message_id ASC LIMIT ?`).all(conversationId, toIso(after), limit);
  return (rows as Record<string, unknown>[]).map(rowToMessage);
}

/**
 * Newest-first, reversed on the way out: ascending with a limit took the oldest
 * N, so a thread past its page hid the new replies.
 */
export async function listThreadMessages(
  threadId: string,
  limit = 50,
  before?: Date,
): Promise<MessageRecord[]> {
  const db = getSqliteDb();
  const rows = before
    ? db.prepare(`SELECT * FROM messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC, message_id DESC LIMIT ?`).all(threadId, toIso(before), limit)
    : db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?`).all(threadId, limit);
  const messages = (rows as Record<string, unknown>[]).map(rowToMessage);
  messages.reverse();
  return messages;
}

export async function deleteMessage(conversationId: string, messageId: string): Promise<boolean> {
  const db = getSqliteDb();
  const result = db.prepare(`DELETE FROM messages WHERE conversation_id = ? AND message_id = ?`).run(conversationId, messageId);
  return result.changes > 0;
}

export async function getMessageById(conversationId: string, messageId: string): Promise<MessageRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`).get(conversationId, messageId) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

export async function updateMessageText(conversationId: string, messageId: string, newText: string): Promise<MessageRecord | null> {
  const db = getSqliteDb();
  const editedAt = new Date();
  const result = db.prepare(`UPDATE messages SET text = ?, edited_at = ? WHERE conversation_id = ? AND message_id = ?`).run(newText, toIso(editedAt), conversationId, messageId);
  if (result.changes === 0) return null;
  return getMessageById(conversationId, messageId);
}

/** Pins a message, or unpins it with `by` null. Returns the message as it now is, or null if it's gone. */
/** Writes a poll's new votes and returns the message as it now stands (GRYT-1732). */
export async function setMessagePoll(conversationId: string, messageId: string, poll: StoredPoll): Promise<MessageRecord | null> {
  const db = getSqliteDb();
  db.prepare(`UPDATE messages SET poll = ? WHERE conversation_id = ? AND message_id = ?`).run(JSON.stringify(poll), conversationId, messageId);
  return getMessageById(conversationId, messageId);
}

export async function setMessagePinned(conversationId: string, messageId: string, by: string | null): Promise<MessageRecord | null> {
  const db = getSqliteDb();
  const result = db
    .prepare(`UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE conversation_id = ? AND message_id = ?`)
    .run(by ? toIso(new Date()) : null, by, conversationId, messageId);
  if (result.changes === 0) return null;
  return getMessageById(conversationId, messageId);
}

/** A conversation's pinned messages, newest pin first. */
export async function listPinnedMessages(conversationId: string, limit = 50): Promise<MessageRecord[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT ?`)
    .all(conversationId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/** How many a conversation has pinned, for the cap. */
export async function countPinnedMessages(conversationId: string): Promise<number> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND pinned_at IS NOT NULL`).get(conversationId) as { n: number };
  return row.n;
}

export async function insertFile(
  // dominant_color is written later by the image worker, so callers inserting
  // a fresh upload do not supply one.
  record: Omit<FileRecord, "created_at" | "dominant_color" | "thumbnail_px"> & {
    created_at?: Date;
    dominant_color?: string | null;
    thumbnail_px?: number | null;
  },
): Promise<FileRecord> {
  const db = getSqliteDb();
  const created_at = record.created_at ?? new Date();
  db.prepare(
    `INSERT INTO files (file_id, s3_key, mime, size, width, height, thumbnail_key, thumbnail_px, original_name, dominant_color, uploaded_by_server_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(record.file_id, record.s3_key, record.mime ?? null, record.size ?? null, record.width ?? null, record.height ?? null, record.thumbnail_key ?? null, record.thumbnail_px ?? null, record.original_name ?? null, record.dominant_color ?? null, record.uploaded_by_server_user_id ?? null, toIso(created_at));
  return { dominant_color: null, thumbnail_px: null, ...record, created_at };
}

export async function updateFileRecord(fileId: string, updates: { s3_key?: string; mime?: string; size?: number; thumbnail_key?: string | null; thumbnail_px?: number | null; dominant_color?: string | null }): Promise<void> {
  const db = getSqliteDb();
  const sets: string[] = [];
  const vals: SQLInputValue[] = [];
  if (updates.s3_key !== undefined) { sets.push("s3_key = ?"); vals.push(updates.s3_key); }
  if (updates.mime !== undefined) { sets.push("mime = ?"); vals.push(updates.mime); }
  if (updates.size !== undefined) { sets.push("size = ?"); vals.push(updates.size); }
  if (updates.thumbnail_key !== undefined) { sets.push("thumbnail_key = ?"); vals.push(updates.thumbnail_key); }
  if (updates.thumbnail_px !== undefined) { sets.push("thumbnail_px = ?"); vals.push(updates.thumbnail_px); }
  if (updates.dominant_color !== undefined) { sets.push("dominant_color = ?"); vals.push(updates.dominant_color); }
  if (sets.length === 0) return;
  vals.push(fileId);
  db.prepare(`UPDATE files SET ${sets.join(", ")} WHERE file_id = ?`).run(...vals);
}

export async function getFile(fileId: string): Promise<FileRecord | null> {
  const db = getSqliteDb();
  const r = db.prepare(`SELECT * FROM files WHERE file_id = ?`).get(fileId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    file_id: r.file_id as string,
    s3_key: r.s3_key as string,
    mime: (r.mime as string) ?? null,
    size: r.size != null ? Number(r.size) : null,
    width: r.width != null ? Number(r.width) : null,
    height: r.height != null ? Number(r.height) : null,
    thumbnail_key: (r.thumbnail_key as string) ?? null,
    thumbnail_px: r.thumbnail_px != null ? Number(r.thumbnail_px) : null,
    original_name: (r.original_name as string) ?? null,
    dominant_color: (r.dominant_color as string) ?? null,
    created_at: fromIso(r.created_at as string),
  };
}

export async function getFilesByIds(fileIds: string[]): Promise<Map<string, FileRecord>> {
  const result = new Map<string, FileRecord>();
  if (fileIds.length === 0) return result;
  const promises = fileIds.map((id) => getFile(id));
  const records = await Promise.all(promises);
  for (const rec of records) {
    if (rec) result.set(rec.file_id, rec);
  }
  return result;
}

export async function getAllFileRecords(): Promise<FileRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM files`).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    file_id: r.file_id as string,
    s3_key: r.s3_key as string,
    mime: (r.mime as string) ?? null,
    size: r.size != null ? Number(r.size) : null,
    width: r.width != null ? Number(r.width) : null,
    height: r.height != null ? Number(r.height) : null,
    thumbnail_key: (r.thumbnail_key as string) ?? null,
    thumbnail_px: r.thumbnail_px != null ? Number(r.thumbnail_px) : null,
    original_name: (r.original_name as string) ?? null,
    dominant_color: (r.dominant_color as string) ?? null,
    created_at: fromIso(r.created_at as string),
  }));
}

/** The messages that carry a file, for telling their readers it has finished processing. */
export async function listMessagesWithFile(fileId: string): Promise<Array<{ conversation_id: string; message_id: string }>> {
  const db = getSqliteDb();
  return db
    .prepare(`SELECT conversation_id, message_id FROM message_attachments WHERE file_id = ?`)
    .all(fileId) as Array<{ conversation_id: string; message_id: string }>;
}

export async function getAllReferencedAttachmentIds(): Promise<Set<string>> {
  const db = getSqliteDb();
  const ids = new Set<string>();
  const rows = db.prepare(`SELECT attachments FROM messages WHERE attachments IS NOT NULL`).all() as { attachments: string }[];
  for (const row of rows) {
    const attachments: string[] = JSON.parse(row.attachments);
    for (const id of attachments) ids.add(id);
  }
  // A card's pictures and a webhook's per-message avatar are only in the reference table,
  // and an MLS message's files only in its own (GRYT-1523).
  const refs = db
    .prepare(`SELECT file_id FROM message_attachments UNION SELECT file_id FROM mls_attachments`)
    .all() as { file_id: string }[];
  for (const row of refs) ids.add(row.file_id);
  return ids;
}

/** Whether any message still points at a file, as an attachment or as something it shows. */
export async function isFileReferencedByMessage(fileId: string): Promise<boolean> {
  const db = getSqliteDb();
  return Boolean(
    db.prepare(`SELECT 1 FROM message_attachments WHERE file_id = ? UNION ALL SELECT 1 FROM mls_attachments WHERE file_id = ? LIMIT 1`)
      .get(fileId, fileId),
  );
}

/** Everything that can make a file readable, in one indexed read. Null when
    there is no such file. */
export async function getFileOwnership(fileId: string): Promise<FileOwnership | null> {
  const db = getSqliteDb();
  const row = db.prepare(
    `SELECT
       f.uploaded_by_server_user_id AS uploader,
       EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.file_id OR u.banner_file_id = f.file_id) AS user_avatar,
       EXISTS (SELECT 1 FROM webhooks w WHERE w.avatar_file_id = f.file_id) AS webhook_avatar,
       (SELECT json_group_array(DISTINCT t.conversation_id) FROM (
          SELECT a.conversation_id FROM message_attachments a WHERE a.file_id = f.file_id
          UNION SELECT g.conversation_id FROM mls_attachments m JOIN mls_groups g ON g.group_id = m.group_id
           WHERE m.file_id = f.file_id) t) AS attached_to,
       (SELECT json_group_array(c.conversation_id) FROM conversations c WHERE c.icon_file_id = f.file_id) AS icon_of
     FROM files f WHERE f.file_id = ?`,
  ).get(fileId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    uploadedBy: (row.uploader as string) ?? null,
    isAvatar: Boolean(row.user_avatar) || Boolean(row.webhook_avatar),
    attachedTo: JSON.parse((row.attached_to as string) || "[]") as string[],
    groupIconOf: JSON.parse((row.icon_of as string) || "[]") as string[],
  };
}

export async function deleteFileRecord(fileId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`DELETE FROM files WHERE file_id = ?`).run(fileId);
}

function applyReactionToggle(reactions: Reaction[], reactionSrc: string, serverUserId: string): Reaction[] {
  const next = reactions.map((r) => ({ ...r, users: [...r.users] }));
  const existing = next.find((r) => r.src === reactionSrc);
  if (existing) {
    const idx = existing.users.indexOf(serverUserId);
    if (idx !== -1) { existing.users.splice(idx, 1); existing.amount = existing.users.length; }
    else { existing.users.push(serverUserId); existing.amount = existing.users.length; }
  } else {
    next.push({ src: reactionSrc, amount: 1, users: [serverUserId] });
  }
  return next.filter((r) => r.amount > 0);
}

export async function addReactionToMessage(conversationId: string, messageId: string, reactionSrc: string, serverUserId: string): Promise<MessageRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`).get(conversationId, messageId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const oldReactions: Reaction[] = row.reactions ? JSON.parse(row.reactions as string) : [];
  const newReactions = applyReactionToggle(oldReactions, reactionSrc, serverUserId);
  const newJson = newReactions.length > 0 ? JSON.stringify(newReactions) : null;
  db.prepare(`UPDATE messages SET reactions = ? WHERE conversation_id = ? AND message_id = ?`).run(newJson, conversationId, messageId);
  const msg = rowToMessage(row);
  return { ...msg, reactions: newReactions.length > 0 ? newReactions : null };
}

export async function removeReactionFromMessage(conversationId: string, messageId: string, reactionSrc: string, serverUserId: string): Promise<MessageRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`).get(conversationId, messageId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const oldReactions: Reaction[] = row.reactions ? JSON.parse(row.reactions as string) : [];
  const existing = oldReactions.find((r) => r.src === reactionSrc);
  if (!existing || !existing.users.includes(serverUserId)) return null;
  const newReactions = oldReactions.map((r) => {
    if (r.src !== reactionSrc) return r;
    const users = r.users.filter((u) => u !== serverUserId);
    return { ...r, users, amount: users.length };
  }).filter((r) => r.amount > 0);
  const newJson = newReactions.length > 0 ? JSON.stringify(newReactions) : null;
  db.prepare(`UPDATE messages SET reactions = ? WHERE conversation_id = ? AND message_id = ?`).run(newJson, conversationId, messageId);
  const msg = rowToMessage(row);
  return { ...msg, reactions: newReactions.length > 0 ? newReactions : null };
}

/** The other half is the reactions they left on other people's messages, which
    live as JSON and are rewritten row by row. Returns what changed. */
export async function purgeUserContent(senderServerUserId: string): Promise<{
  deletedMessages: Array<{ conversation_id: string; message_id: string }>;
  updatedReactions: Array<{ conversation_id: string; message_id: string; reactions: Reaction[] | null }>;
  orphanedAttachmentIds: string[];
}> {
  const db = getSqliteDb();

  const deletedRows = db
    .prepare(`SELECT conversation_id, message_id, attachments FROM messages WHERE sender_server_id = ?`)
    .all(senderServerUserId) as Array<{ conversation_id: string; message_id: string; attachments: string | null }>;
  const deletedMessages = deletedRows.map(({ conversation_id, message_id }) => ({ conversation_id, message_id }));

  // Read before the DELETE, because afterwards there is nothing left to say
  // which files these messages carried.
  const attachmentIds = new Set<string>();
  for (const row of deletedRows) {
    if (!row.attachments) continue;
    try {
      const parsed: unknown = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === "string") attachmentIds.add(id);
      }
    } catch {
      // A row whose attachments will not parse is not a reason to abandon a
      // ban. The sweep still finds the file later by the same orphan rule.
    }
  }

  db.prepare(`DELETE FROM messages WHERE sender_server_id = ?`).run(senderServerUserId);

  // The LIKE is a cheap prefilter over a JSON blob; the parse below is
  // authoritative, since a substring can hit an id containing this one.
  const candidates = db
    .prepare(`SELECT conversation_id, message_id, reactions FROM messages WHERE reactions IS NOT NULL AND reactions LIKE ?`)
    .all(`%${senderServerUserId}%`) as Array<{ conversation_id: string; message_id: string; reactions: string }>;

  const updatedReactions: Array<{ conversation_id: string; message_id: string; reactions: Reaction[] | null }> = [];
  const update = db.prepare(`UPDATE messages SET reactions = ? WHERE conversation_id = ? AND message_id = ?`);

  for (const row of candidates) {
    let parsed: Reaction[];
    try {
      parsed = JSON.parse(row.reactions) as Reaction[];
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    let touched = false;
    const next = parsed
      .map((r) => {
        if (!r.users?.includes(senderServerUserId)) return r;
        touched = true;
        const users = r.users.filter((u) => u !== senderServerUserId);
        return { ...r, users, amount: users.length };
      })
      .filter((r) => r.users.length > 0);

    if (!touched) continue;

    const value = next.length > 0 ? JSON.stringify(next) : null;
    update.run(value, row.conversation_id, row.message_id);
    updatedReactions.push({
      conversation_id: row.conversation_id,
      message_id: row.message_id,
      reactions: next.length > 0 ? next : null,
    });
  }

  // A file can be attached to more than one message, and the ones left behind
  // belong to people who are not being banned.
  const stillReferenced = await getAllReferencedAttachmentIds();
  const orphanedAttachmentIds = [...attachmentIds].filter((id) => !stillReferenced.has(id));

  return { deletedMessages, updatedReactions, orphanedAttachmentIds };
}

/** Counts what is still there, so a delete moves somebody back down. Costs
    nothing, since the promotion thresholds never take a role away. */
export async function countMessagesBySender(senderServerUserId: string): Promise<number> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE sender_server_id = ?`)
    .get(senderServerUserId) as { cnt: number } | undefined;
  return Number(row?.cnt ?? 0);
}

/** Where a match starts and ends in a search snippet. Control characters, so no text can fake one. */
/** Control characters can't be typed and would collide with the snippet marks. */
function withoutControlChars(word: string): string {
  return [...word].filter((c) => c.charCodeAt(0) > 0x1f).join("");
}

export const SEARCH_MARK_START = "\u0002";
export const SEARCH_MARK_END = "\u0003";

/**
 * What somebody typed, as an FTS5 query that can only mean "these words": each word quoted, the
 * last one a prefix. Null when nothing searchable is left. Operators and syntax never get through.
 */
export function toFtsQuery(input: string): string | null {
  const words = input.normalize("NFC").slice(0, 200).split(/\s+/).map(withoutControlChars).filter(Boolean).slice(0, 8);
  if (words.length === 0) return null;
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export interface MessageSearchHit {
  conversation_id: string;
  message_id: string;
  thread_id: string | null;
  /** For a thread reply, the message the thread hangs off, which is what history can open at. */
  thread_root_message_id: string | null;
  sender_server_id: string;
  sender_display_name: string | null;
  created_at: Date;
  snippet: string;
  /** Files only: the attachment whose name matched. */
  file?: { file_id: string; name: string | null; mime: string | null; size: number | null };
}

export type SearchHas = "image" | "link" | "file";
export type SearchKind = "messages" | "files";

/** Totals are counted this far and no further, so a broad word can't scan the whole table twice. */
export const SEARCH_COUNT_CAP = 1000;

export interface MessageSearchParams {
  kind?: SearchKind;
  query: string;
  conversationIds: readonly string[];
  senderServerId?: string;
  before?: Date;
  after?: Date;
  has?: SearchHas;
  limit: number;
}

/** File names match when every word appears in them, case-insensitive, `%` and `_` taken literally. */
function nameWords(input: string): string[] {
  return input.normalize("NFC").slice(0, 200).split(/\s+/).map(withoutControlChars).filter(Boolean).slice(0, 8)
    .map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

function searchSql(p: MessageSearchParams): { from: string; where: string; args: SQLInputValue[]; select: string } | null {
  if (p.conversationIds.length === 0) return null;
  const args: SQLInputValue[] = [];
  const where: string[] = [];
  let from: string;
  let select: string;
  if (p.kind === "files") {
    const words = nameWords(p.query);
    from = `message_attachments a JOIN files f ON f.file_id = a.file_id JOIN messages m ON m.conversation_id = a.conversation_id AND m.message_id = a.message_id`;
    select = `substr(coalesce(m.text, ''), 1, 160) AS snippet, f.file_id, f.original_name, f.mime, f.size`;
    for (const w of words) {
      where.push(`f.original_name LIKE ? ESCAPE '\\'`);
      args.push(w);
    }
  } else {
    const match = toFtsQuery(p.query);
    if (match) {
      from = `messages_fts JOIN messages m ON m.rowid = messages_fts.rowid`;
      select = `snippet(messages_fts, 0, char(2), char(3), '…', 16) AS snippet`;
      where.push(`messages_fts MATCH ?`);
      args.push(match);
    } else {
      // Filters alone, like from: somebody: no words to mark, so the start of the text.
      from = `messages m`;
      select = `substr(coalesce(m.text, ''), 1, 160) AS snippet`;
      where.push(`(m.text IS NOT NULL OR EXISTS (SELECT 1 FROM message_attachments x WHERE x.conversation_id = m.conversation_id AND x.message_id = m.message_id))`);
    }
    if (p.has === "file") where.push(`EXISTS (SELECT 1 FROM message_attachments x WHERE x.conversation_id = m.conversation_id AND x.message_id = m.message_id)`);
    if (p.has === "image") where.push(`EXISTS (SELECT 1 FROM message_attachments x JOIN files xf ON xf.file_id = x.file_id WHERE x.conversation_id = m.conversation_id AND x.message_id = m.message_id AND xf.mime LIKE 'image/%')`);
    if (p.has === "link") where.push(`(m.text LIKE '%http://%' OR m.text LIKE '%https://%')`);
  }
  where.push(`m.conversation_id IN (SELECT value FROM json_each(?))`, `m.mls_seq IS NULL`);
  args.push(JSON.stringify(p.conversationIds));
  if (p.senderServerId) { where.push(`m.sender_server_id = ?`); args.push(p.senderServerId); }
  if (p.after) { where.push(`m.created_at > ?`); args.push(toIso(p.after)); }
  return { from, where: where.join(" AND "), args, select };
}

/**
 * Newest first, only in `conversationIds`: the caller decides what the asker may read, and
 * nothing here widens it. `before` pages on created_at; `total` stops at SEARCH_COUNT_CAP.
 */
export async function searchMessages(p: MessageSearchParams): Promise<{ items: MessageSearchHit[]; total: number }> {
  const sql = searchSql(p);
  if (!sql) return { items: [], total: 0 };
  const db = getSqliteDb();
  const page = p.before ? ` AND m.created_at < ?` : "";
  const rows = db.prepare(
    `SELECT m.conversation_id, m.message_id, m.thread_id, t.root_message_id AS thread_root_message_id, m.sender_server_id, m.sender_display_name, m.created_at, ${sql.select}
       FROM ${sql.from}
       LEFT JOIN threads t ON t.thread_id = m.thread_id
      WHERE ${sql.where}${page}
      ORDER BY m.created_at DESC
      LIMIT ?`,
  ).all(...sql.args, ...(p.before ? [toIso(p.before)] : []), Math.min(Math.max(Math.floor(p.limit), 1), 50)) as Record<string, unknown>[];
  const { n } = db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${sql.from} WHERE ${sql.where} LIMIT ${SEARCH_COUNT_CAP})`).get(...sql.args) as { n: number };
  const items = rows.map((r) => ({
    conversation_id: r.conversation_id as string,
    message_id: r.message_id as string,
    thread_id: (r.thread_id as string) ?? null,
    thread_root_message_id: (r.thread_root_message_id as string) ?? null,
    sender_server_id: r.sender_server_id as string,
    sender_display_name: (r.sender_display_name as string) ?? null,
    created_at: fromIso(r.created_at as string),
    snippet: (r.snippet as string) ?? "",
    ...(p.kind === "files" && {
      file: {
        file_id: r.file_id as string,
        name: (r.original_name as string) ?? null,
        mime: (r.mime as string) ?? null,
        size: (r.size as number) ?? null,
      },
    }),
  }));
  return { items, total: n };
}
