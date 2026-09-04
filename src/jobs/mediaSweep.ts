import consola from "consola";
import {
  deleteFileRecord,
  getAllAvatarFileIds,
  getAllFileRecords,
  getAllReferencedAttachmentIds,
} from "../db";
import { deleteObject } from "../storage";

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
        await deleteObject({ bucket, key: file.thumbnail_key }).catch((e) => consola.warn("S3 thumbnail delete failed", e));
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

/**
 * Delete named files now, without waiting for the sweep (GRYT-139). The sweep's
 * grace period runs from upload and protects a file not yet attached to a
 * message — so it holds exactly the content a moderator is trying to remove,
 * for up to half an hour, still fetchable by anyone with the URL.
 *
 * Failures are logged and stepped over. A ban that fails because S3 was
 * unhappy is worse than a file that survives, and it survives only until the
 * next sweep finds it orphaned.
 */
/**
 * Which of `fileIds` nothing points at any more. Separate from the delete so
 * the selection can be asserted on its own. Reads the same two sources as the
 * periodic sweep, so it cannot select something the sweep would have kept.
 */
export async function unreferencedAmong(fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];

  const [referencedByMessages, referencedByAvatars] = await Promise.all([
    getAllReferencedAttachmentIds(),
    getAllAvatarFileIds(),
  ]);
  const referenced = new Set<string>([...referencedByMessages, ...referencedByAvatars]);

  return fileIds.filter((id) => !referenced.has(id));
}

/**
 * Delete the ones among `fileIds` that nothing points at any more.
 *
 * `deleteFilesNow` trusts its caller to have checked; this does the checking,
 * which is what you want at a call site deleting one message that has no idea
 * what else might reference its attachments. A file can be attached to several
 * messages — forwarding one is enough.
 */
export async function deleteUnreferencedFiles(fileIds: string[]): Promise<{ deleted: number; errors: number }> {
  return deleteFilesNow(await unreferencedAmong(fileIds));
}

export async function deleteFilesNow(fileIds: string[]): Promise<{ deleted: number; errors: number }> {
  if (fileIds.length === 0) return { deleted: 0, errors: 0 };

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    consola.warn("[media-sweep] S3_BUCKET not configured, leaving files for the sweep");
    return { deleted: 0, errors: 0 };
  }

  const wanted = new Set(fileIds);
  const files = (await getAllFileRecords()).filter((f) => wanted.has(f.file_id));

  let deleted = 0;
  let errors = 0;

  for (const file of files) {
    try {
      await deleteObject({ bucket, key: file.s3_key });
      if (file.thumbnail_key) {
        await deleteObject({ bucket, key: file.thumbnail_key }).catch((e) =>
          consola.warn("[media-sweep] thumbnail delete failed", e),
        );
      }
      await deleteFileRecord(file.file_id);
      deleted++;
    } catch (err) {
      consola.error(`[media-sweep] Immediate delete failed for ${file.file_id} (${file.s3_key}):`, err);
      errors++;
    }
  }

  if (deleted || errors) {
    consola.info(`[media-sweep] Immediate delete: ${deleted} removed, ${errors} left for the sweep`);
  }
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
