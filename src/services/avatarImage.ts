import consola from "consola";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

import { AVATAR_MAX_PX, AVATAR_THUMB_PX } from "../constants/media";
import { insertFile, updateFileRecord } from "../db";
import { deleteObject, putObject } from "../storage";
import { findDominantColor, validateImage, MAX_INPUT_PIXELS } from "../utils/imageValidation";

export type StoredAvatarPicture =
  | { ok: true; fileId: string; processing: boolean }
  | { ok: false; status: 400 | 502; error: "invalid_file" | "s3_error"; message: string };

/** Every raster avatar is stored through here, cut down to AVATAR_MAX_PX with a
    thumbnail. SVG must not reach it: sharp renders SVG through librsvg. */
export async function storeAvatarPicture(input: {
  bucket: string;
  bytes: Buffer;
  /** As claimed. `validateImage` checks what the bytes really are. */
  mime: string;
  originalName: string | null;
  uploadedBy: string;
  /** An animation this size or under, within the pixel bound, is kept as sent. */
  maxBytes: number;
  /** Names the picture in a storage error, e.g. "Avatar". */
  what: string;
}): Promise<StoredAvatarPicture> {
  const { bucket, bytes, originalName, uploadedBy, maxBytes, what } = input;
  const fileId = uuidv4();
  const inputMime = input.mime.toLowerCase();
  const isAnimated = inputMime === "image/gif" || inputMime === "image/webp";
  const animExt = inputMime === "image/gif" ? "gif" : "webp";

  let key: string;
  let storedBody: Buffer;
  let storedMime: string;
  let storedSize: number;
  let width: number | null = null;
  let height: number | null = null;
  let thumbKey: string | null = null;
  let processing = false;

  const validation = await validateImage(bytes, { animated: isAnimated });
  if (!validation.valid) {
    return { ok: false, status: 400, error: "invalid_file", message: validation.reason };
  }
  width = validation.width;
  height = validation.height;

  // Dimensions, not bytes: what is left is the modestly-sized animated
  // avatar with large dimensions.
  const withinBounds =
    bytes.length <= maxBytes &&
    (width ?? 0) <= AVATAR_MAX_PX &&
    (height ?? 0) <= AVATAR_MAX_PX;

  if (isAnimated && withinBounds) {
    key = `avatars/${fileId}.${animExt}`;
    storedBody = bytes;
    storedMime = inputMime;
    storedSize = bytes.length;

    const thumb = await sharp(bytes, { pages: 1, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: AVATAR_THUMB_PX, height: AVATAR_THUMB_PX, fit: "cover" })
      .avif({ quality: 50 })
      .toBuffer()
      .catch(() => null);

    if (thumb) {
      thumbKey = `avatars/thumb_${fileId}.avif`;
      await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/avif" }).catch((e) => {
        console.error("avatar_thumb_s3_error", { bucket, key: thumbKey, message: (e instanceof Error ? e.message : "S3 upload failed.") });
        thumbKey = null;
      });
    }
  } else if (isAnimated) {
    key = `avatars/${fileId}.avif`;
    processing = true;
    try {
      storedBody = await sharp(bytes, { pages: 1, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" })
        .avif()
        .toBuffer();
    } catch {
      return { ok: false, status: 400, error: "invalid_file", message: "Could not process image." };
    }
    storedMime = "image/avif";
    storedSize = storedBody.length;
    // What was stored, not what was uploaded: `cover` crops to exactly
    // this box, so the original describes a file that is gone.
    width = AVATAR_MAX_PX;
    height = AVATAR_MAX_PX;
  } else {
    key = `avatars/${fileId}.avif`;
    try {
      storedBody = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" })
        .avif()
        .toBuffer();
    } catch {
      return { ok: false, status: 400, error: "invalid_file", message: "Could not process image. Please upload a valid image under the size limit." };
    }
    storedMime = "image/avif";
    storedSize = storedBody.length;
    width = AVATAR_MAX_PX;
    height = AVATAR_MAX_PX;

    const thumb = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: AVATAR_THUMB_PX, height: AVATAR_THUMB_PX, fit: "cover" })
      .avif({ quality: 50 })
      .toBuffer()
      .catch(() => null);

    if (thumb) {
      thumbKey = `avatars/thumb_${fileId}.avif`;
      await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/avif" }).catch((e) => {
        console.error("avatar_thumb_s3_error", { bucket, key: thumbKey, message: (e instanceof Error ? e.message : "S3 upload failed.") });
        thumbKey = null;
      });
    }
  }

  try {
    await putObject({ bucket, key, body: storedBody, contentType: storedMime });
  } catch (e) {
    const raw = (e instanceof Error && e.message.trim().length > 0) ? e.message : "";
    console.error("avatar_upload_s3_error", { bucket, key, message: raw });
    const friendly =
      /InvalidBucketName|NoSuchBucket|bucket/i.test(raw)
        ? "File storage is misconfigured on this server. Please contact the server administrator."
        : /AccessDenied|Forbidden/i.test(raw)
          ? "File storage access denied. Please contact the server administrator."
          : raw.length > 0
            ? `${what} upload failed: ${raw}`
            : `${what} upload failed due to a storage error.`;
    return { ok: false, status: 502, error: "s3_error", message: friendly };
  }

  // From the original upload, not `storedBody`, which for an oversized
  // animated avatar is a placeholder replaced further down.
  const dominantColor = await findDominantColor(bytes, { animated: isAnimated });

  await insertFile({
    file_id: fileId,
    s3_key: key,
    mime: storedMime,
    size: storedSize,
    width,
    height,
    thumbnail_key: thumbKey,
    thumbnail_px: thumbKey ? AVATAR_THUMB_PX : null,
    original_name: originalName,
    dominant_color: dominantColor,
    uploaded_by_server_user_id: uploadedBy,
    created_at: new Date(),
  });

  // Background: resize oversized animated file and replace the placeholder
  if (processing) {
    const animBuf = bytes;
    setImmediate(() => {
      (async () => {
        try {
          const outputFormat = inputMime === "image/gif" ? "gif" : "webp";
          const outputMime = `image/${outputFormat}`;
          // Every frame is decoded here, unlike the single-page check
          // that let this buffer through, so the ceiling comes with it.
          const pipeline = sharp(animBuf, { animated: true, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
            .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" });
          const resized = outputFormat === "gif"
            ? await pipeline.gif().toBuffer()
            : await pipeline.webp().toBuffer();

          const animKey = `avatars/${fileId}.${outputFormat}`;
          await putObject({ bucket, key: animKey, body: resized, contentType: outputMime });

          const thumbBuf = await sharp(resized, { pages: 1, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
            .resize({ width: AVATAR_THUMB_PX, height: AVATAR_THUMB_PX, fit: "cover" })
            .avif({ quality: 50 })
            .toBuffer()
            .catch(() => null);
          const newThumbKey = thumbBuf ? `avatars/thumb_${fileId}.avif` : null;
          if (thumbBuf && newThumbKey) {
            await putObject({ bucket, key: newThumbKey, body: thumbBuf, contentType: "image/avif" }).catch(() => {});
          }

          await updateFileRecord(fileId, { s3_key: animKey, mime: outputMime, size: resized.length, thumbnail_key: newThumbKey, thumbnail_px: newThumbKey ? AVATAR_THUMB_PX : null });

          if (animKey !== key) {
            await deleteObject({ bucket, key }).catch(() => {});
          }

          consola.info(`Background avatar processing done for ${fileId} (${(resized.length / 1024).toFixed(0)}KB ${outputFormat})`);
        } catch (err) {
          consola.error(`Background avatar processing failed for ${fileId}`, err);
        }
      })();
    });
  }

  return { ok: true, fileId, processing };
}
