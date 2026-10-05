import { v4 as uuidv4 } from "uuid";

import { getFile, insertFile, insertImageJob } from "../db";
import { deleteFilesNow } from "../jobs/mediaSweep";
import { getObjectAsBuffer, putObject } from "../storage";
import { QUARANTINE_PREFIX, settleQuarantine } from "./quarantineUpload";

/* A picture the server needs back, such as an emoji or its icon, decoded in the worker's
   jail instead of here. The worker's copy is returned and the temporary file is dropped. */
const WAIT_MS = 2 * 60_000;

export interface WorkerCopy {
  body: Buffer;
  mime: string;
  ext: string;
}

export async function reencodeThroughWorker(
  bytes: Buffer,
  mime: string,
  use: "emojis" | "avatars",
): Promise<WorkerCopy> {
  const bucket = process.env.S3_BUCKET as string;
  const fileId = uuidv4();
  const key = `${QUARANTINE_PREFIX}${use}/${fileId}`;
  await putObject({ bucket, key, body: bytes, contentType: mime });
  await insertFile({
    file_id: fileId,
    s3_key: key,
    mime,
    size: bytes.length,
    width: null,
    height: null,
    thumbnail_key: null,
    original_name: null,
    uploaded_by_server_user_id: null,
    created_at: new Date(),
  });
  await insertImageJob({ job_id: uuidv4(), file_id: fileId, raw_s3_key: key, raw_content_type: mime, raw_bytes: bytes.length });
  try {
    const verdict = await settleQuarantine(fileId, undefined, WAIT_MS);
    if (verdict !== "ready") throw new Error(verdict === "refused" ? "The image could not be processed." : "The image worker took too long.");
    const done = await getFile(fileId);
    if (!done) throw new Error("The image could not be processed.");
    const out = await getObjectAsBuffer({ bucket, key: done.s3_key });
    return { body: out, mime: done.mime ?? mime, ext: done.s3_key.split(".").pop() || "bin" };
  } finally {
    // The caller stores its own copy, under its own key.
    await deleteFilesNow([fileId]).catch(() => undefined);
  }
}
