import consola from "consola";
import { getAllFileRecords, getAllReferencedAttachmentIds, deleteFileRecord } from "../db/messages";
import { getAllAvatarFileIds } from "../db/users";
import { deleteObject } from "../storage/s3";

const SWEEP_INTERVAL_MS = parseInt(process.env.MEDIA_SWEEP_INTERVAL_MS || String(10 * 60 * 1000)); // default 10 min
const GRACE_PERIOD_MS = parseInt(process.env.MEDIA_SWEEP_GRACE_MS || String(30 * 60 * 1000)); // default 30 min

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export async function runMediaSweep(): Promise<{ deleted: number; errors: number }> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    consola.warn("[media-sweep] S3_BUCKET not configured, skipping sweep");
    return { deleted: 0, errors: 0 };
  }

  const now = Date.now();
  let deleted = 0;
  let errors = 0;

  const [allFiles, referencedByMessages, referencedByAvatars] = await Promise.all([
    getAllFileRecords(),
    getAllReferencedAttachmentIds(),
    getAllAvatarFileIds(),
  ]);

  const referencedIds = new Set<string>([...referencedByMessages, ...referencedByAvatars]);

  const orphaned = allFiles.filter((f) => {
    if (referencedIds.has(f.file_id)) return false;
    const ageMs = now - new Date(f.created_at).getTime();
    return ageMs > GRACE_PERIOD_MS;
  });

  if (orphaned.length === 0) {
    consola.debug(`[media-sweep] No orphaned files (${allFiles.length} total, ${referencedIds.size} referenced)`);
    return { deleted: 0, errors: 0 };
  }

  consola.info(`[media-sweep] Found ${orphaned.length} orphaned file(s) to clean up`);

  for (const file of orphaned) {
    try {
      await deleteObject({ bucket, key: file.s3_key });
      if (file.thumbnail_key) {
        await deleteObject({ bucket, key: file.thumbnail_key }).catch(() => {});
      }
      await deleteFileRecord(file.file_id);
      deleted++;
    } catch (err) {
      consola.error(`[media-sweep] Failed to delete file ${file.file_id} (${file.s3_key}):`, err);
      errors++;
    }
  }

  consola.info(`[media-sweep] Sweep complete: ${deleted} deleted, ${errors} errors`);
  return { deleted, errors };
}

export function startMediaSweep(): void {
  consola.info(`[media-sweep] Starting periodic sweep every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s (grace period: ${Math.round(GRACE_PERIOD_MS / 1000)}s)`);

  setTimeout(() => {
    runMediaSweep().catch((err) => consola.error("[media-sweep] Sweep failed:", err));
  }, 30_000);

  sweepTimer = setInterval(() => {
    runMediaSweep().catch((err) => consola.error("[media-sweep] Sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}

export function stopMediaSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
