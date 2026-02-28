import type { EmojiJobListItem, EmojiJobRecord, EmojiJobStatus } from "../interfaces";
import { fromIso, getSqliteDb, toIso } from "./connection";

function statusFromDb(value: unknown): EmojiJobStatus {
  const v = typeof value === "string" ? value : "";
  if (v === "queued" || v === "processing" || v === "done" || v === "error" || v === "superseded") return v;
  return "error";
}

function rowToJob(r: Record<string, unknown>): EmojiJobRecord {
  return {
    job_id: r.job_id as string, name: r.name as string, status: statusFromDb(r.status),
    raw_s3_key: r.raw_s3_key as string, raw_content_type: r.raw_content_type as string, raw_bytes: Number(r.raw_bytes ?? 0),
    out_s3_key: (r.out_s3_key as string) ?? null, out_content_type: (r.out_content_type as string) ?? null,
    file_id: (r.file_id as string) ?? null, error_message: (r.error_message as string) ?? null,
    uploaded_by_server_user_id: r.uploaded_by_server_user_id as string,
    created_at: fromIso(r.created_at as string), updated_at: fromIso(r.updated_at as string),
  };
}

export async function insertEmojiJob(input: {
  job_id: string; name: string; raw_s3_key: string; raw_content_type: string; raw_bytes: number;
  uploaded_by_server_user_id: string; created_at?: Date;
}): Promise<EmojiJobRecord> {
  const db = getSqliteDb();
  const now = input.created_at ?? new Date();
  const iso = toIso(now);
  db.prepare(
    `INSERT INTO emoji_jobs (job_id, name, status, raw_s3_key, raw_content_type, raw_bytes, uploaded_by_server_user_id, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`
  ).run(input.job_id, input.name, input.raw_s3_key, input.raw_content_type, input.raw_bytes, input.uploaded_by_server_user_id, iso, iso);
  return { ...input, job_id: input.job_id, status: "queued", out_s3_key: null, out_content_type: null, file_id: null, error_message: null, created_at: now, updated_at: now, raw_bytes: input.raw_bytes };
}

export async function getEmojiJob(job_id: string): Promise<EmojiJobRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM emoji_jobs WHERE job_id = ?`).get(job_id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export async function getLatestEmojiJobIdByName(name: string): Promise<string | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT job_id FROM emoji_jobs WHERE name = ? ORDER BY updated_at DESC LIMIT 1`).get(name) as { job_id: string } | undefined;
  return row?.job_id ?? null;
}

export async function listEmojiJobs(limit: number): Promise<EmojiJobListItem[]> {
  const db = getSqliteDb();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db.prepare(`SELECT job_id, name, status, error_message, created_at, updated_at FROM emoji_jobs ORDER BY created_at DESC LIMIT ?`).all(safeLimit) as Record<string, unknown>[];
  return rows.map((r) => ({
    job_id: r.job_id as string, name: r.name as string, status: statusFromDb(r.status),
    error_message: (r.error_message as string) ?? null, created_at: fromIso(r.created_at as string), updated_at: fromIso(r.updated_at as string),
  }));
}

export async function listQueuedJobIds(limit: number): Promise<Array<{ job_id: string; created_at: Date }>> {
  const db = getSqliteDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db.prepare(`SELECT job_id, created_at FROM emoji_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`).all(safeLimit) as Record<string, unknown>[];
  return rows.map((r) => ({ job_id: r.job_id as string, created_at: fromIso(r.created_at as string) }));
}

export async function updateEmojiJobStatus(input: {
  job_id: string; status: EmojiJobStatus; error_message?: string | null;
  out_s3_key?: string | null; out_content_type?: string | null; file_id?: string | null;
}): Promise<EmojiJobRecord | null> {
  const db = getSqliteDb();
  const existing = await getEmojiJob(input.job_id);
  if (!existing) return null;
  const updated_at = new Date();
  const sets = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [input.status, toIso(updated_at)];
  if (input.error_message !== undefined) { sets.push("error_message = ?"); vals.push(input.error_message); }
  if (input.out_s3_key !== undefined) { sets.push("out_s3_key = ?"); vals.push(input.out_s3_key); }
  if (input.out_content_type !== undefined) { sets.push("out_content_type = ?"); vals.push(input.out_content_type); }
  if (input.file_id !== undefined) { sets.push("file_id = ?"); vals.push(input.file_id); }
  vals.push(input.job_id);
  db.prepare(`UPDATE emoji_jobs SET ${sets.join(", ")} WHERE job_id = ?`).run(...vals);
  return getEmojiJob(input.job_id);
}
