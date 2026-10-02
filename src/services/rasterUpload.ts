import { v4 as uuidv4 } from "uuid";
import { deleteFileRecord, getFile, getImageJob, insertFile, insertImageJob } from "../db";
import { deleteObject, getObjectAsBuffer, putObject } from "../storage";
import { mediaMimeFromHeader } from "../utils/mediaSignature";

export class RasterProcessingError extends Error {
  constructor(readonly status: 400 | 503, message: string) { super(message); }
}

export interface RasterUpload {
  bucket: string;
  bytes: Buffer;
  uploadedBy: string | null;
  originalName: string | null;
  profile: "avatar" | "emoji" | "icon";
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  maxFrames?: number;
  maxBytes: number;
  timeoutMs?: number;
}

export async function waitForRaster(fileId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getImageJob(fileId);
    if (!job) throw new RasterProcessingError(503, "Image processing is unavailable.");
    if (job.status === "error") throw new RasterProcessingError(400, "Image processing rejected this file.");
    if (job.status === "done") {
      const file = await getFile(fileId);
      if (!file || !["image/avif", "image/webp"].includes(file.mime ?? "") || !file.width || !file.height || file.s3_key.startsWith("quarantine/")) throw new RasterProcessingError(503, "Image processing did not produce a usable file.");
      return file;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new RasterProcessingError(503, "Image processing is taking too long. Try again later.");
}

export async function processRasterUpload(input: RasterUpload) {
  const mime = mediaMimeFromHeader(input.bytes.subarray(0, 32));
  if (!mime?.startsWith("image/")) throw new RasterProcessingError(400, "Unsupported image format.");
  if (input.bytes.length > 64 * 1024 * 1024 || (input.maxBytes > 0 && input.bytes.length > input.maxBytes)) throw new RasterProcessingError(400, "Image exceeds the upload limit.");
  const values = [input.width, input.height, input.thumbWidth, input.thumbHeight];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 2048)) throw new RasterProcessingError(400, "Invalid image dimensions.");
  const frames = input.maxFrames ?? 480;
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 480) throw new RasterProcessingError(400, "Invalid animation limit.");
  const fileId = uuidv4();
  const key = `quarantine/transforms/${input.profile}/${values.join("-")}-${frames}/${fileId}`;
  await putObject({ bucket: input.bucket, key, body: input.bytes, contentType: mime });
  try {
    await insertFile({ file_id: fileId, s3_key: key, mime, size: input.bytes.length, width: null, height: null,
      thumbnail_key: null, thumbnail_px: input.thumbWidth, original_name: input.originalName,
      uploaded_by_server_user_id: input.uploadedBy, created_at: new Date() });
    await insertImageJob({ job_id: fileId, file_id: fileId, raw_s3_key: key, raw_content_type: mime, raw_bytes: input.bytes.length });
  } catch (error) {
    await deleteObject({ bucket: input.bucket, key }).catch(() => undefined);
    await deleteFileRecord(fileId).catch(() => undefined);
    throw error;
  }
  const file = await waitForRaster(fileId, input.timeoutMs);
  if (input.profile !== "emoji" && (file.width !== input.width || file.height !== input.height)) throw new RasterProcessingError(503, "Image worker does not support the requested crop.");
  if (input.maxBytes > 0 && (file.size ?? 0) > input.maxBytes) throw new RasterProcessingError(400, "Processed image exceeds the upload limit.");
  return file;
}

export async function consumeRasterUpload(input: RasterUpload) {
  const file = await processRasterUpload(input);
  try {
    const processed = await getObjectAsBuffer({ bucket: input.bucket, key: file.s3_key });
    return { processed, ext: file.mime === "image/avif" ? "avif" : "webp", contentType: file.mime! };
  } finally {
    await deleteObject({ bucket: input.bucket, key: file.s3_key });
    if (file.thumbnail_key) await deleteObject({ bucket: input.bucket, key: file.thumbnail_key });
    await deleteFileRecord(file.file_id);
  }
}
