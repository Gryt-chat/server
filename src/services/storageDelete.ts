import consola from "consola";

import { getFile, markFilesDeleted } from "../db";
import { deleteObject, uploadsFolder } from "../storage";
import { resendMessagesWithFile } from "./chatAttachmentSettle";

/** Deletes files an owner picked: the bytes go, the row stays marked so its messages say "Deleted". */
export async function deleteStoredFiles(fileIds: string[]): Promise<{ deleted: number; bytes: number }> {
  const bucket = uploadsFolder();
  let deleted = 0;
  let bytes = 0;
  for (const id of fileIds) {
    const file = await getFile(id);
    if (!file || file.deleted_at) continue;
    try {
      await deleteObject({ bucket, key: file.s3_key });
      if (file.thumbnail_key) await deleteObject({ bucket, key: file.thumbnail_key }).catch(() => undefined);
    } catch (err) {
      consola.warn(`[storage] Could not delete ${id}, left as it was`, err);
      continue;
    }
    markFilesDeleted([id]);
    deleted++;
    bytes += file.size ?? 0;
    await resendMessagesWithFile(id).catch((err) => consola.warn(`[storage] Could not resend messages for ${id}`, err));
  }
  return { deleted, bytes };
}
