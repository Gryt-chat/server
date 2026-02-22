import { randomUUID } from "crypto";
import { getScyllaClient } from "./scylla";

export interface Reaction {
  src: string; // Image source/URL for the reaction
  amount: number; // Count of users who reacted with this image
  users: string[]; // Array of server_user_ids who reacted with this image
}

export interface MessageRecord {
  conversation_id: string;
  message_id: string; // uuid string
  sender_server_id: string; // Secret server user ID (never exposed)
  text: string | null;
  created_at: Date;
  attachments: string[] | null; // file_id uuid strings
  reactions: Reaction[] | null; // Array of reactions to this message
  reply_to_message_id?: string | null;
  sender_nickname?: string; // Enriched at read time, not stored in DB
  sender_avatar_file_id?: string; // Enriched at read time, not stored in DB
}

export interface FileRecord {
  file_id: string; // uuid string
  s3_key: string;
  mime: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  thumbnail_key: string | null;
  original_name: string | null;
  created_at: Date;
}

export async function insertMessage(record: Omit<MessageRecord, "message_id" | "created_at"> & { created_at?: Date; message_id?: string }): Promise<MessageRecord> {
  const c = getScyllaClient();
  const created_at = record.created_at ?? new Date();
  const message_id = record.message_id ?? randomUUID();
  const reactionsJson = record.reactions ? JSON.stringify(record.reactions) : null;

  await c.execute(
    `INSERT INTO messages_by_conversation (conversation_id, created_at, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.conversation_id, created_at, message_id, record.sender_server_id, record.text ?? null, record.attachments ?? null, reactionsJson, record.reply_to_message_id ?? null],
    { prepare: true },
  );
  return { ...record, created_at, message_id } as MessageRecord;
}

export async function listMessages(conversationId: string, limit = 50, before?: Date): Promise<MessageRecord[]> {
  const c = getScyllaClient();
  const cols = `conversation_id, created_at, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id`;

  // Always fetch in DESC order so we get the *latest* N messages,
  // then reverse to return chronological (oldest-first) order for the UI.
  const query = before
    ? `SELECT ${cols} FROM messages_by_conversation WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC, message_id DESC LIMIT ?`
    : `SELECT ${cols} FROM messages_by_conversation WHERE conversation_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?`;

  const params = before
    ? [conversationId, before, limit]
    : [conversationId, limit];

  const rs = await c.execute(query, params, { prepare: true });

  const messages: MessageRecord[] = rs.rows.map((r) => ({
    conversation_id: r["conversation_id"],
    created_at: r["created_at"],
    message_id: r["message_id"].toString(),
    sender_server_id: r["sender_server_id"],
    text: r["text"],
    attachments: r["attachments"] ?? null,
    reactions: r["reactions"] ? JSON.parse(r["reactions"]) : null,
    reply_to_message_id: r["reply_to_message_id"] ?? null,
  }));

  messages.reverse();
  return messages;
}

export async function deleteMessage(conversationId: string, messageId: string): Promise<boolean> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT created_at FROM messages_by_conversation WHERE conversation_id = ? AND message_id = ? ALLOW FILTERING`,
    [conversationId, messageId],
    { prepare: true },
  );
  const row = rs.first();
  if (!row) return false;

  await c.execute(
    `DELETE FROM messages_by_conversation WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [conversationId, row["created_at"], messageId],
    { prepare: true },
  );
  return true;
}

export async function getMessageById(conversationId: string, messageId: string): Promise<MessageRecord | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT conversation_id, created_at, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id FROM messages_by_conversation WHERE conversation_id = ? AND message_id = ? ALLOW FILTERING`,
    [conversationId, messageId],
    { prepare: true },
  );
  const row = rs.first();
  if (!row) return null;
  return {
    conversation_id: row["conversation_id"],
    created_at: row["created_at"],
    message_id: row["message_id"].toString(),
    sender_server_id: row["sender_server_id"],
    text: row["text"],
    attachments: row["attachments"] ?? null,
    reactions: row["reactions"] ? JSON.parse(row["reactions"]) : null,
    reply_to_message_id: row["reply_to_message_id"] ?? null,
  };
}

export async function insertFile(record: Omit<FileRecord, "created_at"> & { created_at?: Date }): Promise<FileRecord> {
  const c = getScyllaClient();
  const created_at = record.created_at ?? new Date();
  await c.execute(
    `INSERT INTO files_by_id (file_id, s3_key, mime, size, width, height, thumbnail_key, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.file_id, record.s3_key, record.mime ?? null, record.size ?? null, record.width ?? null, record.height ?? null, record.thumbnail_key ?? null, record.original_name ?? null, created_at],
    { prepare: true }
  );
  return { ...record, created_at };
}

export async function getFile(fileId: string): Promise<FileRecord | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT file_id, s3_key, mime, size, width, height, thumbnail_key, original_name, created_at FROM files_by_id WHERE file_id = ?`,
    [fileId],
    { prepare: true }
  );
  const r = rs.first();
  if (!r) return null;
  return {
    file_id: r["file_id"].toString(),
    s3_key: r["s3_key"],
    mime: r["mime"],
    size: Number(r["size"] ?? 0),
    width: r["width"],
    height: r["height"],
    thumbnail_key: r["thumbnail_key"],
    original_name: r["original_name"] ?? null,
    created_at: r["created_at"],
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
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT file_id, s3_key, mime, size, width, height, thumbnail_key, original_name, created_at FROM files_by_id`,
    [],
    { prepare: true, fetchSize: 1000 },
  );
  return rs.rows.map((r) => ({
    file_id: r["file_id"].toString(),
    s3_key: r["s3_key"],
    mime: r["mime"],
    size: Number(r["size"] ?? 0),
    width: r["width"],
    height: r["height"],
    thumbnail_key: r["thumbnail_key"],
    original_name: r["original_name"] ?? null,
    created_at: r["created_at"],
  }));
}

export async function getAllReferencedAttachmentIds(): Promise<Set<string>> {
  const c = getScyllaClient();
  const ids = new Set<string>();
  const rs = await c.execute(
    `SELECT attachments FROM messages_by_conversation`,
    [],
    { prepare: true, fetchSize: 5000 },
  );
  for (const row of rs.rows) {
    const attachments: string[] | null = row["attachments"];
    if (attachments) {
      for (const id of attachments) ids.add(id);
    }
  }
  return ids;
}

export async function deleteFileRecord(fileId: string): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `DELETE FROM files_by_id WHERE file_id = ?`,
    [fileId],
    { prepare: true },
  );
}

export async function addReactionToMessage(
  conversationId: string,
  messageId: string,
  reactionSrc: string,
  serverUserId: string,
): Promise<MessageRecord | null> {
  const c = getScyllaClient();

  const rs = await c.execute(
    `SELECT conversation_id, created_at, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id FROM messages_by_conversation WHERE conversation_id = ? AND message_id = ? ALLOW FILTERING`,
    [conversationId, messageId],
    { prepare: true },
  );

  const row = rs.first();
  if (!row) return null;

  const reactions: Reaction[] = row["reactions"] ? JSON.parse(row["reactions"]) : [];
  const existingReaction = reactions.find(r => r.src === reactionSrc);

  if (existingReaction) {
    if (existingReaction.users.includes(serverUserId)) {
      existingReaction.users.splice(existingReaction.users.indexOf(serverUserId), 1);
      existingReaction.amount = existingReaction.users.length;
      if (existingReaction.amount === 0) reactions.splice(reactions.indexOf(existingReaction), 1);
    } else {
      existingReaction.users.push(serverUserId);
      existingReaction.amount = existingReaction.users.length;
    }
  } else {
    reactions.push({ src: reactionSrc, amount: 1, users: [serverUserId] });
  }

  const reactionsJson = reactions.length > 0 ? JSON.stringify(reactions) : null;
  await c.execute(
    `UPDATE messages_by_conversation SET reactions = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [reactionsJson, conversationId, row["created_at"], messageId],
    { prepare: true },
  );

  return {
    conversation_id: row["conversation_id"],
    created_at: row["created_at"],
    message_id: row["message_id"].toString(),
    sender_server_id: row["sender_server_id"],
    text: row["text"],
    attachments: row["attachments"] ?? null,
    reactions: reactions.length > 0 ? reactions : null,
    reply_to_message_id: row["reply_to_message_id"] ?? null,
  };
}

export async function removeReactionFromMessage(
  conversationId: string,
  messageId: string,
  reactionSrc: string,
  serverUserId: string,
): Promise<MessageRecord | null> {
  const c = getScyllaClient();

  const rs = await c.execute(
    `SELECT conversation_id, created_at, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id FROM messages_by_conversation WHERE conversation_id = ? AND message_id = ? ALLOW FILTERING`,
    [conversationId, messageId],
    { prepare: true },
  );

  const row = rs.first();
  if (!row) return null;

  const reactions: Reaction[] = row["reactions"] ? JSON.parse(row["reactions"]) : [];
  const idx = reactions.findIndex(r => r.src === reactionSrc);
  if (idx === -1) return null;

  const existing = reactions[idx];
  const userIdx = existing.users.indexOf(serverUserId);
  if (userIdx === -1) return null;

  existing.users.splice(userIdx, 1);
  existing.amount = existing.users.length;
  if (existing.amount === 0) reactions.splice(idx, 1);

  const reactionsJson = reactions.length > 0 ? JSON.stringify(reactions) : null;
  await c.execute(
    `UPDATE messages_by_conversation SET reactions = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [reactionsJson, conversationId, row["created_at"], messageId],
    { prepare: true },
  );

  return {
    conversation_id: row["conversation_id"],
    created_at: row["created_at"],
    message_id: row["message_id"].toString(),
    sender_server_id: row["sender_server_id"],
    text: row["text"],
    attachments: row["attachments"] ?? null,
    reactions: reactions.length > 0 ? reactions : null,
    reply_to_message_id: row["reply_to_message_id"] ?? null,
  };
}
