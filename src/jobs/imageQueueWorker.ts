import consola from "consola";

import {
  DEFAULT_UPLOAD_MAX_BYTES,
  getImageJob,
  getServerConfig,
  listQueuedImageJobIds,
  updateFileRecord,
  updateImageJobStatus,
} from "../db";
import { processUploadedImage } from "./processImage";

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function startImageQueueWorker(): void {
  if ((globalThis as { __grytImageWorkerStarted?: boolean }).__grytImageWorkerStarted) return;
  (globalThis as { __grytImageWorkerStarted?: boolean }).__grytImageWorkerStarted = true;

  const bucket = (process.env.S3_BUCKET || "").trim();
  if (!bucket) {
    consola.warn("[ImageQueue] S3_BUCKET missing; worker disabled.");
    return;
  }

  const concurrency = clampInt(process.env.IMAGE_WORKER_CONCURRENCY, 2, 1, 8);
  const pollMs = clampInt(process.env.IMAGE_WORKER_POLL_MS, 1000, 250, 10_000);

  consola.info(`[ImageQueue] Worker starting (concurrency=${concurrency}, pollMs=${pollMs})`);

  let inFlight = 0;

  const runOne = async (jobId: string) => {
    try {
      const job = await getImageJob(jobId);
      if (!job || job.status !== "queued") return;

      await updateImageJobStatus({ job_id: jobId, status: "processing" });

      const cfg = await getServerConfig();
      const maxBytes = cfg?.upload_max_bytes ?? DEFAULT_UPLOAD_MAX_BYTES;

      const result = await processUploadedImage(
        bucket,
        job.file_id,
        job.raw_s3_key,
        job.raw_content_type,
        job.raw_bytes,
        maxBytes,
      );

      const updates: { s3_key?: string; mime?: string; size?: number; thumbnail_key?: string | null } = {};
      if (result.compressed && result.newKey && result.newMime && result.newSize !== null) {
        updates.s3_key = result.newKey;
        updates.mime = result.newMime;
        updates.size = result.newSize;
      }
      if (result.thumbKey) {
        updates.thumbnail_key = result.thumbKey;
      }

      if (Object.keys(updates).length > 0) {
        await updateFileRecord(job.file_id, updates);
      }

      await updateImageJobStatus({ job_id: jobId, status: "done" });
      consola.info(
        `[ImageQueue] Job ${jobId} done (file=${job.file_id}, compressed=${result.compressed}, thumb=${!!result.thumbKey})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consola.error(`[ImageQueue] Job ${jobId} failed:`, msg);
      await updateImageJobStatus({
        job_id: jobId,
        status: "error",
        error_message: msg,
      }).catch((e: unknown) => consola.warn("Failed to update image job status", e));
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const tick = async () => {
    if (inFlight >= concurrency) return;
    const capacity = concurrency - inFlight;
    const queued = await listQueuedImageJobIds(capacity).catch(() => []);
    if (queued.length === 0) return;
    for (const { job_id } of queued) {
      if (inFlight >= concurrency) break;
      inFlight++;
      runOne(job_id)
        .catch((e: unknown) => consola.warn("image queue tick failed", e))
        .finally(() => { inFlight--; });
    }
  };

  setInterval(() => {
    tick().catch((e: unknown) => consola.warn("image queue tick failed", e));
  }, pollMs);
}
