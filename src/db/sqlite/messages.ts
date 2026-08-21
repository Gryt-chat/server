import { randomUUID } from "crypto";

import type { FileRecord, MessageRecord, Reaction } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso, type SQLInputValue } from "./connection";

function rowToMessage(r: Record<string, unknown>): MessageRecord {
  return {
    conversation_id: r.conversation_id as string,
    message_id: r.message_id as string,
    sender_server_id: r.sender_server_id as string,
    text: (r.text as string) ?? null,
    created_at: fromIso(r.created_at as string),
    edited_at: fromIsoNullable(r.edited_at as string | null),
    attachments: r.attachments ? JSON.parse(r.attachments as string) : null,
    reactions: r.reactions ? JSON.parse(r.reactions as string) : null,
    reply_to_message_id: (r.reply_to_message_id as string) ?? null,
  };
}

export async function insertMessage(record: Omit<MessageRecord, "message_id" | "created_at"> & { created_at?: Date; message_id?: string }): Promise<MessageRecord> {
  const db = getSqliteDb();
  const created_at = record.created_at ?? new Date();
  const message_id = record.message_id ?? randomUUID();

  db.prepare(
    `INSERT INTO messages (conversation_id, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.conversation_id,
    message_id,
    record.sender_server_id,
    record.text ?? null,
    record.attachments ? JSON.stringify(record.attachments) : null,
    record.reactions ? JSON.stringify(record.reactions) : null,
    record.reply_to_message_id ?? null,
    toIso(created_at),
  );

  return { ...record, created_at, message_id } as MessageRecord;
}

export async function listMessages(conversationId: string, limit = 50, before?: Date): Promise<MessageRecord[]> {
  const db = getSqliteDb();
  const rows = before
    ? db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC, message_id DESC LIMIT ?`).all(conversationId, toIso(before), limit)
    : db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?`).all(conversationId, limit);
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
    `INSERT INTO files (file_id, s3_key, mime, size, width, height, thumbnail_key, thumbnail_px, original_name, dominant_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(record.file_id, record.s3_key, record.mime ?? null, record.size ?? null, record.width ?? null, record.height ?? null, record.thumbnail_key ?? null, record.thumbnail_px ?? null, record.original_name ?? null, record.dominant_color ?? null, toIso(created_at));
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

export async function getAllReferencedAttachmentIds(): Promise<Set<string>> {
  const db = getSqliteDb();
  const ids = new Set<string>();
  const rows = db.prepare(`SELECT attachments FROM messages WHERE attachments IS NOT NULL`).all() as { attachments: string }[];
  for (const row of rows) {
    const attachments: string[] = JSON.parse(row.attachments);
    for (const id of attachments) ids.add(id);
  }
  return ids;
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

/**
 * Removes every trace of a user from the message history.
 *
 * Deleting their messages is the obvious half. The other half is the
 * reactions they left on everybody else's, which live as JSON on each
 * message rather than in a table of their own — so they cannot be removed
 * with a DELETE and have to be rewritten row by row.
 *
 * A reaction whose last user was this person disappears entirely rather than
 * lingering with a count of zero.
 *
 * Returns what changed so the callers can tell connected clients: deleted
 * messages by id, and the messages whose reactions were rewritten. Also the
 * files those messages carried, so the caller can take them out of storage
 * without waiting for the sweep (GRYT-139).
 */
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

  // Only rows that mention them at all. The LIKE is a cheap prefilter over a
  // JSON blob — the authoritative check is the parse below, because a
  // substring match can hit an id that merely contains this one.
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

  // Only the ones nothing else points at any more. A file can be attached to
  // more than one message, and the messages left behind belong to people who
  // are not being banned.
  const stillReferenced = await getAllReferencedAttachmentIds();
  const orphanedAttachmentIds = [...attachmentIds].filter((id) => !stillReferenced.has(id));

  return { deletedMessages, updatedReactions, orphanedAttachmentIds };
}

/**
 * How many messages one member has sent, ever.
 *
 * For the automatic-promotion thresholds. Counts what is still there rather
 * than what was ever posted, which means a purge or a moderator's delete moves
 * somebody back down the count — that is the honest reading of "has posted
 * fifty messages", and it costs nothing to say so here since nothing is ever
 * taken away once granted.
 */
export async function countMessagesBySender(senderServerUserId: string): Promise<number> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE sender_server_id = ?`)
    .get(senderServerUserId) as { cnt: number } | undefined;
  return Number(row?.cnt ?? 0);
}
