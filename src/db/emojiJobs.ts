import { getScyllaClient } from "./scylla";

export type EmojiJobStatus = "queued" | "processing" | "done" | "error" | "superseded";

export interface EmojiJobRecord {
  job_id: string;
  name: string;
  status: EmojiJobStatus;
  raw_s3_key: string;
  raw_content_type: string;
  raw_bytes: number;
  out_s3_key: string | null;
  out_content_type: string | null;
  file_id: string | null;
  error_message: string | null;
  uploaded_by_server_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface EmojiJobListItem {
  job_id: string;
  name: string;
  status: EmojiJobStatus;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

const BUCKET = "all";

function statusFromDb(value: unknown): EmojiJobStatus {
  const v = typeof value === "string" ? value : "";
  if (v === "queued" || v === "processing" || v === "done" || v === "error" || v === "superseded") return v;
  return "error";
}

export async function insertEmojiJob(input: {
  job_id: string;
  name: string;
  raw_s3_key: string;
  raw_content_type: string;
  raw_bytes: number;
  uploaded_by_server_user_id: string;
  created_at?: Date;
}): Promise<EmojiJobRecord> {
  const c = getScyllaClient();
  const now = input.created_at ?? new Date();
  const updated_at = now;
  const status: EmojiJobStatus = "queued";

  await c.execute(
    `INSERT INTO server_emoji_jobs_by_id (job_id, name, status, raw_s3_key, raw_content_type, raw_bytes, out_s3_key, out_content_type, file_id, error_message, uploaded_by_server_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.job_id,
      input.name,
      status,
      input.raw_s3_key,
      input.raw_content_type,
      input.raw_bytes,
      null,
      null,
      null,
      null,
      input.uploaded_by_server_user_id,
      now,
      updated_at,
    ],
    { prepare: true },
  );

  await c.execute(
    `INSERT INTO server_emoji_jobs_by_status (status, created_at, job_id, name, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [status, now, input.job_id, input.name, updated_at],
    { prepare: true },
  );

  await c.execute(
    `INSERT INTO server_emoji_jobs_by_created (bucket, created_at, job_id, name, status, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [BUCKET, now, input.job_id, input.name, status, null, updated_at],
    { prepare: true },
  );

  await c.execute(
    `INSERT INTO server_emoji_latest_job_by_name (name, job_id, updated_at) VALUES (?, ?, ?)`,
    [input.name, input.job_id, updated_at],
    { prepare: true },
  );

  return {
    job_id: input.job_id,
    name: input.name,
    status,
    raw_s3_key: input.raw_s3_key,
    raw_content_type: input.raw_content_type,
    raw_bytes: input.raw_bytes,
    out_s3_key: null,
    out_content_type: null,
    file_id: null,
    error_message: null,
    uploaded_by_server_user_id: input.uploaded_by_server_user_id,
    created_at: now,
    updated_at,
  };
}

export async function getEmojiJob(job_id: string): Promise<EmojiJobRecord | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT job_id, name, status, raw_s3_key, raw_content_type, raw_bytes, out_s3_key, out_content_type, file_id, error_message, uploaded_by_server_user_id, created_at, updated_at
     FROM server_emoji_jobs_by_id WHERE job_id = ?`,
    [job_id],
    { prepare: true },
  );
  const r = rs.first();
  if (!r) return null;
  return {
    job_id: r["job_id"].toString(),
    name: r["name"],
    status: statusFromDb(r["status"]),
    raw_s3_key: r["raw_s3_key"],
    raw_content_type: r["raw_content_type"],
    raw_bytes: Number(r["raw_bytes"] ?? 0),
    out_s3_key: r["out_s3_key"] ?? null,
    out_content_type: r["out_content_type"] ?? null,
    file_id: r["file_id"] ? r["file_id"].toString() : null,
    error_message: r["error_message"] ?? null,
    uploaded_by_server_user_id: r["uploaded_by_server_user_id"],
    created_at: r["created_at"],
    updated_at: r["updated_at"],
  };
}

export async function getLatestEmojiJobIdByName(name: string): Promise<string | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT job_id FROM server_emoji_latest_job_by_name WHERE name = ?`,
    [name],
    { prepare: true },
  );
  const r = rs.first();
  if (!r) return null;
  return r["job_id"] ? r["job_id"].toString() : null;
}

export async function listEmojiJobs(limit: number): Promise<EmojiJobListItem[]> {
  const c = getScyllaClient();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rs = await c.execute(
    `SELECT created_at, job_id, name, status, error_message, updated_at
     FROM server_emoji_jobs_by_created WHERE bucket = ? LIMIT ${safeLimit}`,
    [BUCKET],
    { prepare: true },
  );
  return rs.rows.map((r) => ({
    job_id: r["job_id"].toString(),
    name: r["name"],
    status: statusFromDb(r["status"]),
    error_message: r["error_message"] ?? null,
    created_at: r["created_at"],
    updated_at: r["updated_at"],
  }));
}

export async function listQueuedJobIds(limit: number): Promise<Array<{ job_id: string; created_at: Date }>> {
  const c = getScyllaClient();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rs = await c.execute(
    `SELECT created_at, job_id FROM server_emoji_jobs_by_status WHERE status = ? LIMIT ${safeLimit}`,
    ["queued"],
    { prepare: true },
  );
  return rs.rows.map((r) => ({
    job_id: r["job_id"].toString(),
    created_at: r["created_at"],
  }));
}

export async function updateEmojiJobStatus(input: {
  job_id: string;
  status: EmojiJobStatus;
  error_message?: string | null;
  out_s3_key?: string | null;
  out_content_type?: string | null;
  file_id?: string | null;
}): Promise<EmojiJobRecord | null> {
  const c = getScyllaClient();
  const existing = await getEmojiJob(input.job_id);
  if (!existing) return null;

  const updated_at = new Date();
  const nextStatus = input.status;
  const error_message = typeof input.error_message === "string" ? input.error_message : (input.error_message ?? existing.error_message);
  const out_s3_key = typeof input.out_s3_key === "string" ? input.out_s3_key : (input.out_s3_key ?? existing.out_s3_key);
  const out_content_type = typeof input.out_content_type === "string" ? input.out_content_type : (input.out_content_type ?? existing.out_content_type);
  const file_id = typeof input.file_id === "string" ? input.file_id : (input.file_id ?? existing.file_id);

  await c.execute(
    `UPDATE server_emoji_jobs_by_id
     SET status = ?, error_message = ?, out_s3_key = ?, out_content_type = ?, file_id = ?, updated_at = ?
     WHERE job_id = ?`,
    [nextStatus, error_message, out_s3_key, out_content_type, file_id, updated_at, input.job_id],
    { prepare: true },
  );

  await c.execute(
    `INSERT INTO server_emoji_jobs_by_status (status, created_at, job_id, name, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [nextStatus, existing.created_at, input.job_id, existing.name, updated_at],
    { prepare: true },
  );

  await c.execute(
    `DELETE FROM server_emoji_jobs_by_status WHERE status = ? AND created_at = ? AND job_id = ?`,
    [existing.status, existing.created_at, input.job_id],
    { prepare: true },
  );

  await c.execute(
    `UPDATE server_emoji_jobs_by_created
     SET status = ?, error_message = ?, updated_at = ?
     WHERE bucket = ? AND created_at = ? AND job_id = ?`,
    [nextStatus, error_message, updated_at, BUCKET, existing.created_at, input.job_id],
    { prepare: true },
  );

  return {
    ...existing,
    status: nextStatus,
    error_message,
    out_s3_key,
    out_content_type,
    file_id,
    updated_at,
  };
}

