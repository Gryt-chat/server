import { v4 as uuidv4 } from "uuid";
import { insertFile, insertImageJob } from "../db";
import { deleteObject, putObject } from "../storage";

const bannerTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4"]);

export async function storeBannerUpload(input: {
  bucket: string; file: Express.Multer.File; uploadedBy: string; maxBytes: number;
}) {
  const { bucket, file, uploadedBy, maxBytes } = input;
  const type = file.mimetype.toLowerCase();
  if (!bannerTypes.has(type)) return { ok: false as const, status: 400, error: "invalid_file", message: "Only raster images and MP4 videos are allowed" };
  if (maxBytes > 0 && file.size > maxBytes) return { ok: false as const, status: 413, error: "file_too_large", message: "Banner exceeds the server upload limit" };
  const fileId = uuidv4();
  const key = `quarantine/banners/${fileId}`;
  await putObject({ bucket, key, sourcePath: file.path, contentType: type });
  try {
    await insertFile({ file_id: fileId, s3_key: key, mime: type, size: file.size,
      width: null, height: null, thumbnail_key: null, original_name: file.originalname,
      uploaded_by_server_user_id: uploadedBy });
    await insertImageJob({ job_id: fileId, file_id: fileId, raw_s3_key: key, raw_content_type: type, raw_bytes: file.size });
  } catch (error) {
    await deleteObject({ bucket, key }).catch(() => undefined);
    throw error;
  }
  return { ok: true as const, fileId, processing: true };
}
