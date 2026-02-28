import { randomUUID } from "crypto";

import type { FileRecord, MessageRecord, Reaction } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

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

export async function insertFile(record: Omit<FileRecord, "created_at"> & { created_at?: Date }): Promise<FileRecord> {
  const db = getSqliteDb();
  const created_at = record.created_at ?? new Date();
  db.prepare(
    `INSERT INTO files (file_id, s3_key, mime, size, width, height, thumbnail_key, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(record.file_id, record.s3_key, record.mime ?? null, record.size ?? null, record.width ?? null, record.height ?? null, record.thumbnail_key ?? null, record.original_name ?? null, toIso(created_at));
  return { ...record, created_at };
}

export async function updateFileRecord(fileId: string, updates: { s3_key?: string; mime?: string; size?: number; thumbnail_key?: string | null }): Promise<void> {
  const db = getSqliteDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.s3_key !== undefined) { sets.push("s3_key = ?"); vals.push(updates.s3_key); }
  if (updates.mime !== undefined) { sets.push("mime = ?"); vals.push(updates.mime); }
  if (updates.size !== undefined) { sets.push("size = ?"); vals.push(updates.size); }
  if (updates.thumbnail_key !== undefined) { sets.push("thumbnail_key = ?"); vals.push(updates.thumbnail_key); }
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
    original_name: (r.original_name as string) ?? null,
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
    original_name: (r.original_name as string) ?? null,
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
