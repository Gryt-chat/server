import { v4 as uuidv4 } from "uuid";

import { getFile, getImageJobStatusForFile, insertFile, insertImageJob } from "../db";
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
    for it. "refused" as soon as the worker gives up on it, null if still waiting after `waitMs`. */
export async function waitOutOfQuarantine<T extends { s3_key: string }>(
  fileId: string,
  first: T,
  read: (id: string) => Promise<T | null> = getFile as unknown as (id: string) => Promise<T | null>,
  waitMs = 15_000,
  stepMs = 250,
  jobStatus: (id: string) => Promise<string | null> = getImageJobStatusForFile,
  holdProcess = true,
): Promise<T | "refused" | null> {
  let file: T | null = first;
  const until = Date.now() + waitMs;
  while (file && isQuarantined(file.s3_key)) {
    if ((await jobStatus(fileId)) === "error") return "refused";
    if (Date.now() >= until) return null;
    await new Promise<void>((r) => {
      const timer = setTimeout(r, stepMs);
      if (!holdProcess) timer.unref();
    });
    file = await read(fileId);
  }
  return file;
}

/* Long enough for a ten-second video on a slow worker. Past it the upload is left alone,
   still in quarantine, and the member keeps what they had. */
const SETTLE_WAIT_MS = 10 * 60_000;

/** Waits for the worker's verdict on a quarantined avatar or banner, so it only replaces
    the old one once it has been written out (GRYT-1664). */
export async function settleQuarantine(
  fileId: string,
  read: (id: string) => Promise<{ s3_key: string } | null> = getFile,
  waitMs = SETTLE_WAIT_MS,
  stepMs = 1_000,
  jobStatus: (id: string) => Promise<string | null> = getImageJobStatusForFile,
): Promise<"ready" | "refused" | "timeout"> {
  const first = await read(fileId);
  if (!first) return "refused";
  // Background work, so it never keeps a shutting-down server (or a test run) alive.
  const out = await waitOutOfQuarantine(fileId, first, read, waitMs, stepMs, jobStatus, false);
  if (out === "refused" || (out === null && (await read(fileId)) === null)) return "refused";
  return out ? "ready" : "timeout";
}
