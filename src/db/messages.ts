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
  edited_at?: Date | null;
  attachments: string[] | null; // file_id uuid strings
  reactions: Reaction[] | null; // Array of reactions to this message
  reply_to_message_id?: string | null;
  sender_nickname?: string; // Enriched at read time, not stored in DB
  sender_avatar_file_id?: string; // Enriched at read time, not stored in DB
  profanity_matches?: { startIndex: number; endIndex: number }[]; // Enriched at broadcast time, not stored in DB
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

const MSG_COLS = `conversation_id, created_at, message_id, sender_server_id, text, attachments, reactions, reply_to_message_id, edited_at`;

function rowToMessage(r: Record<string, unknown>): MessageRecord {
  return {
    conversation_id: r["conversation_id"] as string,
    created_at: r["created_at"] as Date,
    message_id: String(r["message_id"]),
    sender_server_id: r["sender_server_id"] as string,
    text: (r["text"] as string) ?? null,
    attachments: (r["attachments"] as string[] | null) ?? null,
    reactions: r["reactions"] ? JSON.parse(r["reactions"] as string) : null,
    reply_to_message_id: (r["reply_to_message_id"] as string) ?? null,
    edited_at: (r["edited_at"] as Date) ?? null,
  };
}

// ── Timestamp lookup ────────────────────────────────────────────
// message_ts_by_id allows O(1) resolution of created_at from
// (conversation_id, message_id), avoiding ALLOW FILTERING on the
// main table whose PK is (conversation_id, created_at, message_id).

async function writeTimestampLookup(conversationId: string, messageId: string, createdAt: Date): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `INSERT INTO message_ts_by_id (conversation_id, message_id, created_at) VALUES (?, ?, ?)`,
    [conversationId, messageId, createdAt],
    { prepare: true },
  );
}

async function deleteTimestampLookup(conversationId: string, messageId: string): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `DELETE FROM message_ts_by_id WHERE conversation_id = ? AND message_id = ?`,
    [conversationId, messageId],
    { prepare: true },
  );
}

async function resolveCreatedAt(conversationId: string, messageId: string): Promise<Date | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT created_at FROM message_ts_by_id WHERE conversation_id = ? AND message_id = ?`,
    [conversationId, messageId],
    { prepare: true },
  );
  const row = rs.first();
  return row ? (row["created_at"] as Date) : null;
}

async function getMessageByFullPK(conversationId: string, createdAt: Date, messageId: string): Promise<MessageRecord | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT ${MSG_COLS} FROM messages_by_conversation WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [conversationId, createdAt, messageId],
    { prepare: true },
  );
  const row = rs.first();
  return row ? rowToMessage(row) : null;
}

async function resolveMessage(conversationId: string, messageId: string): Promise<{ msg: MessageRecord; createdAt: Date } | null> {
  const createdAt = await resolveCreatedAt(conversationId, messageId);
  if (!createdAt) return null;
  const msg = await getMessageByFullPK(conversationId, createdAt, messageId);
  return msg ? { msg, createdAt } : null;
}

// ── CRUD ────────────────────────────────────────────────────────

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

  await writeTimestampLookup(record.conversation_id, message_id, created_at);

  return { ...record, created_at, message_id } as MessageRecord;
}

export async function listMessages(conversationId: string, limit = 50, before?: Date): Promise<MessageRecord[]> {
  const c = getScyllaClient();
  const query = before
    ? `SELECT ${MSG_COLS} FROM messages_by_conversation WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC, message_id DESC LIMIT ?`
    : `SELECT ${MSG_COLS} FROM messages_by_conversation WHERE conversation_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?`;

  const params = before
    ? [conversationId, before, limit]
    : [conversationId, limit];

  const rs = await c.execute(query, params, { prepare: true });
  const messages = rs.rows.map((r) => rowToMessage(r));
  messages.reverse();
  return messages;
}

export async function deleteMessage(conversationId: string, messageId: string): Promise<boolean> {
  const c = getScyllaClient();
  const createdAt = await resolveCreatedAt(conversationId, messageId);
  if (!createdAt) return false;

  await c.execute(
    `DELETE FROM messages_by_conversation WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [conversationId, createdAt, messageId],
    { prepare: true },
  );
  await deleteTimestampLookup(conversationId, messageId);
  return true;
}

export async function getMessageById(conversationId: string, messageId: string): Promise<MessageRecord | null> {
  const resolved = await resolveMessage(conversationId, messageId);
  return resolved?.msg ?? null;
}

export async function updateMessageText(
  conversationId: string,
  messageId: string,
  newText: string,
): Promise<MessageRecord | null> {
  const resolved = await resolveMessage(conversationId, messageId);
  if (!resolved) return null;

  const editedAt = new Date();
  const c = getScyllaClient();
  await c.execute(
    `UPDATE messages_by_conversation SET text = ?, edited_at = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [newText, editedAt, conversationId, resolved.createdAt, messageId],
    { prepare: true },
  );

  return { ...resolved.msg, text: newText, edited_at: editedAt };
}

// ── Files ───────────────────────────────────────────────────────

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

export async function updateFileRecord(fileId: string, updates: { s3_key?: string; mime?: string; size?: number; thumbnail_key?: string | null }): Promise<void> {
  const c = getScyllaClient();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.s3_key !== undefined) { sets.push("s3_key = ?"); vals.push(updates.s3_key); }
  if (updates.mime !== undefined) { sets.push("mime = ?"); vals.push(updates.mime); }
  if (updates.size !== undefined) { sets.push("size = ?"); vals.push(updates.size); }
  if (updates.thumbnail_key !== undefined) { sets.push("thumbnail_key = ?"); vals.push(updates.thumbnail_key); }
  if (sets.length === 0) return;
  vals.push(fileId);
  await c.execute(`UPDATE files_by_id SET ${sets.join(", ")} WHERE file_id = ?`, vals, { prepare: true });
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
  } as FileRecord;
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
  } as FileRecord));
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
    const attachments: string[] | null = row["attachments"] as string[] | null;
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

// ── Reactions (CAS-protected) ───────────────────────────────────

const MAX_REACTION_RETRIES = 5;

function applyReactionToggle(reactions: Reaction[], reactionSrc: string, serverUserId: string): Reaction[] {
  const next = reactions.map((r) => ({ ...r, users: [...r.users] }));
  const existing = next.find((r) => r.src === reactionSrc);

  if (existing) {
    const idx = existing.users.indexOf(serverUserId);
    if (idx !== -1) {
      existing.users.splice(idx, 1);
      existing.amount = existing.users.length;
    } else {
      existing.users.push(serverUserId);
      existing.amount = existing.users.length;
    }
  } else {
    next.push({ src: reactionSrc, amount: 1, users: [serverUserId] });
  }

  return next.filter((r) => r.amount > 0);
}

export async function addReactionToMessage(
  conversationId: string,
  messageId: string,
  reactionSrc: string,
  serverUserId: string,
): Promise<MessageRecord | null> {
  const c = getScyllaClient();
  const createdAt = await resolveCreatedAt(conversationId, messageId);
  if (!createdAt) return null;

  for (let attempt = 0; attempt < MAX_REACTION_RETRIES; attempt++) {
    const rs = await c.execute(
      `SELECT ${MSG_COLS} FROM messages_by_conversation WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
      [conversationId, createdAt, messageId],
      { prepare: true },
    );
    const row = rs.first();
    if (!row) return null;

    const oldReactionsRaw = row["reactions"] as string | null;
    const oldReactions: Reaction[] = oldReactionsRaw ? JSON.parse(oldReactionsRaw) : [];
    const newReactions = applyReactionToggle(oldReactions, reactionSrc, serverUserId);
    const newJson = newReactions.length > 0 ? JSON.stringify(newReactions) : null;

    const cas = oldReactionsRaw != null
      ? await c.execute(
        `UPDATE messages_by_conversation SET reactions = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ? IF reactions = ?`,
        [newJson, conversationId, createdAt, messageId, oldReactionsRaw],
        { prepare: true },
      )
      : await c.execute(
        `UPDATE messages_by_conversation SET reactions = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ? IF reactions = null`,
        [newJson, conversationId, createdAt, messageId],
        { prepare: true },
      );

    const applied = !!cas.first()?.["[applied]"];
    if (applied) {
      const msg = rowToMessage(row);
      return { ...msg, reactions: newReactions.length > 0 ? newReactions : null };
    }
  }

  return null;
}

export async function removeReactionFromMessage(
  conversationId: string,
  messageId: string,
  reactionSrc: string,
  serverUserId: string,
): Promise<MessageRecord | null> {
  const c = getScyllaClient();
  const createdAt = await resolveCreatedAt(conversationId, messageId);
  if (!createdAt) return null;

  for (let attempt = 0; attempt < MAX_REACTION_RETRIES; attempt++) {
    const rs = await c.execute(
      `SELECT ${MSG_COLS} FROM messages_by_conversation WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
      [conversationId, createdAt, messageId],
      { prepare: true },
    );
    const row = rs.first();
    if (!row) return null;

    const oldReactionsRaw = row["reactions"] as string | null;
    const oldReactions: Reaction[] = oldReactionsRaw ? JSON.parse(oldReactionsRaw) : [];
    const existing = oldReactions.find((r) => r.src === reactionSrc);
    if (!existing || !existing.users.includes(serverUserId)) return null;

    const newReactions = oldReactions.map((r) => {
      if (r.src !== reactionSrc) return r;
      const users = r.users.filter((u) => u !== serverUserId);
      return { ...r, users, amount: users.length };
    }).filter((r) => r.amount > 0);
    const newJson = newReactions.length > 0 ? JSON.stringify(newReactions) : null;

    const cas = oldReactionsRaw != null
      ? await c.execute(
        `UPDATE messages_by_conversation SET reactions = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ? IF reactions = ?`,
        [newJson, conversationId, createdAt, messageId, oldReactionsRaw],
        { prepare: true },
      )
      : await c.execute(
        `UPDATE messages_by_conversation SET reactions = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ? IF reactions = null`,
        [newJson, conversationId, createdAt, messageId],
        { prepare: true },
      );

    const applied = !!cas.first()?.["[applied]"];
    if (applied) {
      const msg = rowToMessage(row);
      return { ...msg, reactions: newReactions.length > 0 ? newReactions : null };
    }
  }

  return null;
}
