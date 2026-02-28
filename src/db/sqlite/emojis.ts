import type { EmojiRecord } from "../interfaces";
import { fromIso, getSqliteDb, toIso } from "./connection";

export async function insertEmoji(record: Omit<EmojiRecord, "created_at"> & { created_at?: Date }): Promise<EmojiRecord> {
  const db = getSqliteDb();
  const created_at = record.created_at ?? new Date();
  db.prepare(`INSERT OR REPLACE INTO emojis (name, file_id, s3_key, uploaded_by_server_user_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    record.name, record.file_id, record.s3_key, record.uploaded_by_server_user_id, toIso(created_at));
  return { ...record, created_at };
}

export async function getEmoji(name: string): Promise<EmojiRecord | null> {
  const db = getSqliteDb();
  const r = db.prepare(`SELECT * FROM emojis WHERE name = ?`).get(name) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { name: r.name as string, file_id: r.file_id as string, s3_key: r.s3_key as string, uploaded_by_server_user_id: r.uploaded_by_server_user_id as string, created_at: fromIso(r.created_at as string) };
}

export async function listEmojis(): Promise<EmojiRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM emojis`).all() as Record<string, unknown>[];
  return rows.map((r) => ({ name: r.name as string, file_id: r.file_id as string, s3_key: r.s3_key as string, uploaded_by_server_user_id: r.uploaded_by_server_user_id as string, created_at: fromIso(r.created_at as string) }));
}

export async function renameEmoji(oldName: string, newName: string): Promise<boolean> {
  const db = getSqliteDb();
  const existing = await getEmoji(oldName);
  if (!existing) return false;
  const txn = db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO emojis (name, file_id, s3_key, uploaded_by_server_user_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      newName, existing.file_id, existing.s3_key, existing.uploaded_by_server_user_id, toIso(existing.created_at));
    db.prepare(`DELETE FROM emojis WHERE name = ?`).run(oldName);
  });
  txn();
  return true;
}

export async function deleteEmoji(name: string): Promise<boolean> {
  const db = getSqliteDb();
  const result = db.prepare(`DELETE FROM emojis WHERE name = ?`).run(name);
  return result.changes > 0;
}
