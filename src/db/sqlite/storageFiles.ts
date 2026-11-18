import { getSqliteDb, type SQLInputValue } from "./connection";

export type StorageSort = "size" | "date" | "name" | "uploader";
export type StorageKind = "video" | "image" | "other";

export interface StorageFileFilter {
  conversationId?: string;
  kind?: StorageKind;
  uploader?: string;
  q?: string;
  olderThan?: Date;
  minBytes?: number;
}

export interface StorageFileRow {
  file_id: string;
  original_name: string | null;
  mime: string | null;
  size: number;
  created_at: string;
  uploader: string | null;
  conversation_id: string;
  message_id: string;
  thread_id: string | null;
  thread_title: string | null;
}

/* One row per file that a message still carries and that hasn't been deleted. A file attached
   to more than one message (forwarded) shows once, at its first message. */
const BASE = `
  FROM files f
  JOIN message_attachments a ON a.file_id = f.file_id
   AND a.rowid = (SELECT MIN(rowid) FROM message_attachments WHERE file_id = f.file_id)
  LEFT JOIN messages m ON m.conversation_id = a.conversation_id AND m.message_id = a.message_id
  LEFT JOIN threads t ON t.thread_id = m.thread_id
  WHERE f.deleted_at IS NULL`;

function where(filter: StorageFileFilter): { sql: string; args: SQLInputValue[] } {
  const parts: string[] = [];
  const args: SQLInputValue[] = [];
  if (filter.conversationId) { parts.push("a.conversation_id = ?"); args.push(filter.conversationId); }
  if (filter.uploader) { parts.push("f.uploaded_by_server_user_id = ?"); args.push(filter.uploader); }
  if (filter.q) { parts.push("f.original_name LIKE ? ESCAPE '\\'"); args.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  if (filter.olderThan) { parts.push("f.created_at < ?"); args.push(filter.olderThan.toISOString()); }
  if (filter.minBytes) { parts.push("f.size >= ?"); args.push(filter.minBytes); }
  if (filter.kind === "video") parts.push("f.mime LIKE 'video/%'");
  if (filter.kind === "image") parts.push("f.mime LIKE 'image/%'");
  if (filter.kind === "other") parts.push("(f.mime IS NULL OR (f.mime NOT LIKE 'video/%' AND f.mime NOT LIKE 'image/%'))");
  return { sql: parts.map((p) => ` AND ${p}`).join(""), args };
}

const ORDER: Record<StorageSort, string> = {
  size: "f.size",
  date: "f.created_at",
  name: "f.original_name COLLATE NOCASE",
  uploader: "f.uploaded_by_server_user_id",
};

export function listStorageFiles(
  filter: StorageFileFilter,
  sort: StorageSort = "size",
  dir: "asc" | "desc" = "desc",
  limit = 50,
  offset = 0,
): { items: StorageFileRow[]; total: number; totalBytes: number } {
  const db = getSqliteDb();
  const w = where(filter);
  const order = `${ORDER[sort] ?? ORDER.size} ${dir === "asc" ? "ASC" : "DESC"}, f.file_id`;
  const items = db.prepare(
    `SELECT f.file_id, f.original_name, f.mime, COALESCE(f.size, 0) AS size, f.created_at,
            f.uploaded_by_server_user_id AS uploader, a.conversation_id, a.message_id, m.thread_id, t.title AS thread_title
       ${BASE}${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...w.args, limit, offset) as unknown as StorageFileRow[];
  const sum = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS bytes ${BASE}${w.sql}`).get(...w.args) as { n: number; bytes: number };
  return { items, total: Number(sum.n), totalBytes: Number(sum.bytes) };
}

/** Every file a filter matches, for a bulk delete. Ids and sizes only. */
export function storageFileIds(filter: StorageFileFilter): Array<{ file_id: string; size: number }> {
  const w = where(filter);
  return getSqliteDb().prepare(`SELECT f.file_id, COALESCE(f.size, 0) AS size ${BASE}${w.sql}`).all(...w.args) as unknown as Array<{ file_id: string; size: number }>;
}

/** The conversations whose files take the most space. */
export function biggestStorageConversations(limit = 5): Array<{ conversation_id: string; files: number; bytes: number }> {
  return getSqliteDb().prepare(
    `SELECT a.conversation_id, COUNT(*) AS files, COALESCE(SUM(f.size), 0) AS bytes ${BASE}
      GROUP BY a.conversation_id ORDER BY bytes DESC LIMIT ?`,
  ).all(limit) as unknown as Array<{ conversation_id: string; files: number; bytes: number }>;
}

export function markFilesDeleted(fileIds: string[], at = new Date()): void {
  const stmt = getSqliteDb().prepare(`UPDATE files SET deleted_at = ? WHERE file_id = ? AND deleted_at IS NULL`);
  for (const id of fileIds) stmt.run(at.toISOString(), id);
}
