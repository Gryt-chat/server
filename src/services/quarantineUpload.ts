import { v4 as uuidv4 } from "uuid";

import { getFile, insertFile, insertImageJob } from "../db";
import { putObject } from "../storage";

export const QUARANTINE_PREFIX = "quarantine/";

export type QuarantineUse = "avatars" | "banners" | "uploads";

/** Stored as sent but out of reach: no route serves a quarantine key. The worker writes
    it out again and moves the row, and the original is deleted then (GRYT-1664). */
export async function quarantineUpload(input: {
  bucket: string;
  use: QuarantineUse;
  bytes: Buffer;
  mime: string;
  originalName: string | null;
  uploadedBy: string;
}): Promise<{ fileId: string; key: string }> {
  const fileId = uuidv4();
  const key = `${QUARANTINE_PREFIX}${input.use}/${fileId}`;
  await putObject({ bucket: input.bucket, key, body: input.bytes, contentType: input.mime });
  await insertFile({
    file_id: fileId,
    s3_key: key,
    mime: input.mime,
    size: input.bytes.length,
    width: null,
    height: null,
    thumbnail_key: null,
    original_name: input.originalName,
    uploaded_by_server_user_id: input.uploadedBy,
    created_at: new Date(),
  });
  await insertImageJob({ job_id: uuidv4(), file_id: fileId, raw_s3_key: key, raw_content_type: input.mime, raw_bytes: input.bytes.length });
  return { fileId, key };
}

export const isQuarantined = (key: string | null | undefined): boolean => !!key && key.startsWith(QUARANTINE_PREFIX);

/** A file just uploaded is usually written out within a second or two, so a read waits
    for it rather than failing. Null when it is still in quarantine after `waitMs`. */
export async function waitOutOfQuarantine<T extends { s3_key: string }>(
  fileId: string,
  first: T,
  read: (id: string) => Promise<T | null> = getFile as unknown as (id: string) => Promise<T | null>,
  waitMs = 15_000,
  stepMs = 250,
): Promise<T | null> {
  let file: T | null = first;
  const until = Date.now() + waitMs;
  while (file && isQuarantined(file.s3_key)) {
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, stepMs));
    file = await read(fileId);
  }
  return file;
}
