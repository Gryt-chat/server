import { readFile, stat } from "node:fs/promises";

import mime from "mime-types";
import { v4 as uuidv4 } from "uuid";

import {
  DEFAULT_EMOJI_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
  getEmoji,
  getFile,
  getLatestEmojiJobIdByName,
  getServerConfig,
  insertEmojiJob,
} from "../../db";
import { EMOJI_NAME_RE } from "../../routes/emojiShared";
import { storeUploadedFile } from "../../services/storeUploadedFile";
import { putObject } from "../../storage";
import type { ImportMedia, StoreOutcome } from "./importer";

function isRasterImage(type: string): boolean {
  return type.startsWith("image/") && type !== "image/svg+xml";
}

/** Through the same function as `POST /api/uploads`, so the same checks, limit and image job apply. */
export const uploadPathMedia: ImportMedia = {
  async storeFile({ fileId, path, originalName, uploadedBy, imageOnly }): Promise<StoreOutcome> {
    if (await getFile(fileId)) return { kind: "exists" };

    const mimetype = mime.lookup(path) || mime.lookup(originalName) || "application/octet-stream";
    if (imageOnly && !isRasterImage(mimetype)) return { kind: "skipped", reason: "not a picture" };

    const info = await stat(path);
    const cfg = await getServerConfig().catch(() => null);
    const maxBytes = typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES;

    const result = await storeUploadedFile({
      bucket: process.env.S3_BUCKET as string,
      path,
      size: info.size,
      mimetype,
      originalName,
      sealed: false,
      uploadedBy,
      maxBytes,
      fileId,
    });
    return result.ok ? { kind: "stored" } : { kind: "skipped", reason: result.message };
  },

  async queueEmoji({ name, path, uploadedBy }): Promise<boolean> {
    if (!EMOJI_NAME_RE.test(name)) return false;
    if ((await getEmoji(name)) || (await getLatestEmojiJobIdByName(name))) return false;

    const contentType = mime.lookup(path) || "";
    if (!isRasterImage(contentType)) return false;
    const cfg = await getServerConfig().catch(() => null);
    const maxBytes = typeof cfg?.emoji_max_bytes === "number" ? cfg.emoji_max_bytes : DEFAULT_EMOJI_MAX_BYTES;
    if ((await stat(path)).size > maxBytes) return false;

    const jobId = uuidv4();
    const rawKey = `emoji_raw/${jobId}`;
    const bytes = await readFile(path);
    await putObject({ bucket: process.env.S3_BUCKET as string, key: rawKey, body: bytes, contentType });
    await insertEmojiJob({
      job_id: jobId,
      name,
      raw_s3_key: rawKey,
      raw_content_type: contentType,
      raw_bytes: bytes.length,
      uploaded_by_server_user_id: uploadedBy,
    });
    return true;
  },
};

/** For a server run with DISABLE_S3, which has nowhere to put a file. The messages still come across. */
export const noFileStorageMedia: ImportMedia = {
  async storeFile(): Promise<StoreOutcome> {
    return { kind: "skipped", reason: "this server has file storage turned off" };
  },
  async queueEmoji(): Promise<boolean> {
    return false;
  },
};
