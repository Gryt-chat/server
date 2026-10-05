import consola from "consola";
import { readFile } from "fs/promises";
import { v4 as uuidv4 } from "uuid";

import { insertFile, insertImageJob } from "../db";
import { storageForUpload } from "../routes/uploadStorage";
import { putObject } from "../storage";
import { validateImage } from "../utils/imageValidation";
import { sanitizeSvg } from "../utils/svgSanitize";
import { PARSE_LIMITS, readVideoDimensionsFromFile } from "../utils/videoDimensions";

/** A validation ceiling, not an upload one: decoding an image means holding it.
    Files and videos are not subject to this. */
export const IMAGE_VALIDATION_MAX_BYTES = 64 * 1024 * 1024;

export type StoreUploadedFileResult =
  | { ok: true; fileId: string; key: string }
  | { ok: false; status: 400 | 413; error: "invalid_file" | "file_too_large"; message: string };

function positiveInt(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Everything `POST /api/uploads` does with a file already on disk, so the Discord
 * importer stores a picture through the same checks and the same image job.
 */
export async function storeUploadedFile(input: {
  bucket: string;
  path: string;
  size: number;
  mimetype: string | undefined;
  originalName: string | undefined;
  sealed: boolean;
  uploadedBy: string | null;
  /** Zero or less means no limit. */
  maxBytes: number;
  claimedWidth?: number | null;
  claimedHeight?: number | null;
  /** A caller that needs the same id on every run passes its own. */
  fileId?: string;
}): Promise<StoreUploadedFileResult> {
  const fileId = input.fileId ?? uuidv4();
  const { bucket, path, size } = input;

  // In its own file because nothing in here loads in a test, and because
  // sealing is the part with a security answer. See `uploadStorage.ts`.
  const storage = storageForUpload({
    sealed: input.sealed,
    fileId,
    mimetype: input.mimetype,
    originalName: input.originalName,
  });

  // Images too: the worker runs after the original is written, and a
  // desktop-hosted server has none. Multer already refused as it streamed.
  if (input.maxBytes > 0 && size > input.maxBytes) {
    return {
      ok: false,
      status: 413,
      error: "file_too_large",
      message: `File too large. Max ${(input.maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
    };
  }

  const { key, storedMime } = storage;
  let width: number | null = null;
  let height: number | null = null;

  // Stored as the sanitised vector and never queued as an image job: the
  // worker would hand it to sharp, which renders SVG through librsvg.
  if (storage.treatAsSvg) {
    const svg = sanitizeSvg(await readFile(path));
    if (!svg.valid) return { ok: false, status: 400, error: "invalid_file", message: svg.reason };

    const body = Buffer.from(svg.svg, "utf8");
    const svgKey = `uploads/${fileId}.svg`;
    await putObject({ bucket, key: svgKey, body, contentType: "image/svg+xml" });

    await insertFile({
      file_id: fileId,
      s3_key: svgKey,
      mime: "image/svg+xml",
      size: body.length,
      width: svg.width,
      height: svg.height,
      thumbnail_key: null,
      // Through the decision rather than off the request, so there is
      // one place the client's filename can reach a row.
      original_name: storage.originalName,
      uploaded_by_server_user_id: input.uploadedBy,
      created_at: new Date(),
    });
    return { ok: true, fileId, key: svgKey };
  }

  if (storage.validateAsImage) {
    // The mime off the request is a claim, and taking it meant an SVG
    // carrying <script> was served back inline.
    if (size > IMAGE_VALIDATION_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        error: "file_too_large",
        message: `Images are capped at ${(IMAGE_VALIDATION_MAX_BYTES / (1024 * 1024)).toFixed(0)}MB so they can be checked before they are stored.`,
      };
    }

    const imageBytes = await readFile(path);
    const validation = await validateImage(imageBytes, { animated: true });
    if (!validation.valid) return { ok: false, status: 400, error: "invalid_file", message: validation.reason };

    width = positiveInt(input.claimedWidth);
    height = positiveInt(input.claimedHeight);

    // `validateImage` already read the dimensions off the same decode.
    // The second library was `image-size`, whose advisory has no fix.
    if (!width || !height) {
      width = validation.width;
      height = validation.height;
    }
  }

  // The whole point of the exercise: the bytes go from the temp file
  // to storage without the process ever holding them.
  await putObject({ bucket, key, sourcePath: path, contentType: storedMime });

  // Headers only, never a decode. The client's claim is the fallback, as it
  // is for images, and only counts when it gives both sides.
  if (storage.measureAsVideo) {
    const claimed = { width: positiveInt(input.claimedWidth), height: positiveInt(input.claimedHeight) };
    const measured = (await readVideoDimensionsFromFile(path)) ?? claimed;
    const fits = (n: number | null) => n !== null && n <= PARSE_LIMITS.maxSide;
    if (fits(measured.width) && fits(measured.height)) {
      width = measured.width;
      height = measured.height;
    }
  }

  await insertFile({
    file_id: fileId,
    s3_key: key,
    mime: storedMime,
    size,
    width,
    height,
    // A video's poster, like an image's thumbnail, is the worker's to fill in.
    thumbnail_key: null,
    original_name: storage.originalName,
    uploaded_by_server_user_id: input.uploadedBy,
    created_at: new Date(),
  });

  if (storage.queueImageJob) {
    await insertImageJob({
      job_id: uuidv4(),
      file_id: fileId,
      raw_s3_key: key,
      raw_content_type: storedMime,
      raw_bytes: size,
    }).catch((e: unknown) => consola.warn("Failed to queue image job", e));
  }

  return { ok: true, fileId, key };
}
