import consola from "consola";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

import { deleteObject, getObject, putObject } from "../storage/s3";
import { getEmoji, insertEmoji } from "../db/emojis";
import { getEmojiJob, getLatestEmojiJobIdByName, listQueuedJobIds, updateEmojiJobStatus } from "../db/emojiJobs";
import { broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate } from "../socket";
import { processEmojiToOptimizedImage } from "../utils/emojiProcessing";

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function startEmojiQueueWorker(): void {
  // Ensure we don't start multiple polling loops (can happen if called from multiple init paths).
  if ((globalThis as { __grytEmojiWorkerStarted?: boolean }).__grytEmojiWorkerStarted) return;
  (globalThis as { __grytEmojiWorkerStarted?: boolean }).__grytEmojiWorkerStarted = true;

  const bucket = (process.env.S3_BUCKET || "").trim();
  if (!bucket) {
    consola.warn("[EmojiQueue] S3_BUCKET missing; worker disabled.");
    return;
  }

  const concurrency = clampInt(process.env.EMOJI_QUEUE_CONCURRENCY, 1, 1, 4);
  const pollMs = clampInt(process.env.EMOJI_QUEUE_POLL_MS, 750, 250, 5000);
  sharp.concurrency(Math.max(1, Math.min(2, concurrency)));

  consola.info(`[EmojiQueue] Worker starting (concurrency=${concurrency}, pollMs=${pollMs})`);

  let inFlight = 0;
  const runOne = async (jobId: string) => {
    try {
      const job = await getEmojiJob(jobId);
      if (!job) return;
      if (job.status !== "queued") return;

      await updateEmojiJobStatus({ job_id: jobId, status: "processing" });
      broadcastEmojiQueueUpdate();

      const latestId = await getLatestEmojiJobIdByName(job.name);
      if (latestId && latestId !== jobId) {
        await updateEmojiJobStatus({ job_id: jobId, status: "superseded" });
        broadcastEmojiQueueUpdate();
        await deleteObject({ bucket, key: job.raw_s3_key }).catch(() => undefined);
        return;
      }

      const obj = await getObject({ bucket, key: job.raw_s3_key });
      const body = obj.Body;
      if (!body) throw new Error("raw_s3_body_missing");
      const bytes = await body.transformToByteArray();
      const rawBuffer = Buffer.from(bytes);

      const { processed, ext, contentType } = await processEmojiToOptimizedImage(rawBuffer, job.raw_content_type.toLowerCase());

      const latestAfterProcess = await getLatestEmojiJobIdByName(job.name);
      if (latestAfterProcess && latestAfterProcess !== jobId) {
        await updateEmojiJobStatus({ job_id: jobId, status: "superseded" });
        broadcastEmojiQueueUpdate();
        await deleteObject({ bucket, key: job.raw_s3_key }).catch(() => undefined);
        return;
      }

      const outKey = `emojis/${job.name}.${ext}`;
      const existing = await getEmoji(job.name);
      if (existing) {
        await deleteObject({ bucket, key: existing.s3_key }).catch(() => undefined);
      }

      const fileId = uuidv4();
      await putObject({ bucket, key: outKey, body: processed, contentType });
      await insertEmoji({ name: job.name, file_id: fileId, s3_key: outKey, uploaded_by_server_user_id: job.uploaded_by_server_user_id });

      await updateEmojiJobStatus({
        job_id: jobId,
        status: "done",
        out_s3_key: outKey,
        out_content_type: contentType,
        file_id: fileId,
        error_message: null,
      });

      broadcastCustomEmojisUpdate();
      broadcastEmojiQueueUpdate();
      await deleteObject({ bucket, key: job.raw_s3_key }).catch(() => undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consola.error("[EmojiQueue] Job failed:", jobId, msg);
      await updateEmojiJobStatus({ job_id: jobId, status: "error", error_message: msg }).catch(() => undefined);
      broadcastEmojiQueueUpdate();
    } finally {
      // Yield so we don't starve the event loop during heavy bursts.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const tick = async () => {
    if (inFlight >= concurrency) return;
    const capacity = concurrency - inFlight;
    const queued = await listQueuedJobIds(capacity).catch(() => []);
    if (queued.length === 0) return;
    for (const { job_id } of queued) {
      if (inFlight >= concurrency) break;
      inFlight++;
      runOne(job_id)
        .catch(() => undefined)
        .finally(() => { inFlight--; });
    }
  };

  setInterval(() => {
    tick().catch(() => undefined);
  }, pollMs);
}

