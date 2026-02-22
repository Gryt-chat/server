import { getScyllaClient } from "./scylla";

export interface EmojiRecord {
  name: string;
  file_id: string;
  s3_key: string;
  uploaded_by_server_user_id: string;
  created_at: Date;
}

export async function insertEmoji(record: Omit<EmojiRecord, "created_at"> & { created_at?: Date }): Promise<EmojiRecord> {
  const c = getScyllaClient();
  const created_at = record.created_at ?? new Date();
  await c.execute(
    `INSERT INTO server_emojis_by_name (name, file_id, s3_key, uploaded_by_server_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    [record.name, record.file_id, record.s3_key, record.uploaded_by_server_user_id, created_at],
    { prepare: true },
  );
  return { ...record, created_at };
}

export async function getEmoji(name: string): Promise<EmojiRecord | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT name, file_id, s3_key, uploaded_by_server_user_id, created_at FROM server_emojis_by_name WHERE name = ?`,
    [name],
    { prepare: true },
  );
  const r = rs.first();
  if (!r) return null;
  return {
    name: r["name"],
    file_id: r["file_id"].toString(),
    s3_key: r["s3_key"],
    uploaded_by_server_user_id: r["uploaded_by_server_user_id"],
    created_at: r["created_at"],
  };
}

export async function listEmojis(): Promise<EmojiRecord[]> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT name, file_id, s3_key, uploaded_by_server_user_id, created_at FROM server_emojis_by_name`,
    [],
    { prepare: true },
  );
  return rs.rows.map((r) => ({
    name: r["name"],
    file_id: r["file_id"].toString(),
    s3_key: r["s3_key"],
    uploaded_by_server_user_id: r["uploaded_by_server_user_id"],
    created_at: r["created_at"],
  }));
}

export async function deleteEmoji(name: string): Promise<boolean> {
  const c = getScyllaClient();
  const existing = await getEmoji(name);
  if (!existing) return false;
  await c.execute(
    `DELETE FROM server_emojis_by_name WHERE name = ?`,
    [name],
    { prepare: true },
  );
  return true;
}
