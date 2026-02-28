import { v4 as uuidv4 } from "uuid";

import type { ImageJobRecord, ImageJobStatus } from "../interfaces";
import { fromIso, getSqliteDb, toIso } from "./connection";

export async function insertImageJob(input: {
  job_id?: string;
  file_id: string;
  raw_s3_key: string;
  raw_content_type: string;
  raw_bytes: number;
}): Promise<ImageJobRecord> {
  const db = getSqliteDb();
  const jobId = input.job_id || uuidv4();
  const now = new Date();
  const nowIso = toIso(now);

  db.prepare(
    `INSERT INTO image_jobs (job_id, file_id, status, raw_s3_key, raw_content_type, raw_bytes, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`
  ).run(jobId, input.file_id, input.raw_s3_key, input.raw_content_type, input.raw_bytes, nowIso, nowIso);

  return {
    job_id: jobId,
    file_id: input.file_id,
    status: "queued",
    raw_s3_key: input.raw_s3_key,
    raw_content_type: input.raw_content_type,
    raw_bytes: input.raw_bytes,
    error_message: null,
    created_at: now,
    updated_at: now,
  };
}

export async function getImageJob(jobId: string): Promise<ImageJobRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare("SELECT * FROM image_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export async function updateImageJobStatus(input: {
  job_id: string;
  status: ImageJobStatus;
  error_message?: string | null;
}): Promise<ImageJobRecord | null> {
  const db = getSqliteDb();
  const now = toIso(new Date());

  const sets: string[] = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [input.status, now];

  if (input.error_message !== undefined) {
    sets.push("error_message = ?");
    vals.push(input.error_message);
  }

  vals.push(input.job_id);
  db.prepare(`UPDATE image_jobs SET ${sets.join(", ")} WHERE job_id = ?`).run(...vals);
  return getImageJob(input.job_id);
}

function mapRow(row: Record<string, unknown>): ImageJobRecord {
  return {
    job_id: row.job_id as string,
    file_id: row.file_id as string,
    status: row.status as ImageJobStatus,
    raw_s3_key: row.raw_s3_key as string,
    raw_content_type: row.raw_content_type as string,
    raw_bytes: (row.raw_bytes as number) || 0,
    error_message: (row.error_message as string) || null,
    created_at: fromIso(row.created_at as string),
    updated_at: fromIso(row.updated_at as string),
  };
}
