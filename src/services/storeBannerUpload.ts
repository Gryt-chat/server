import { storeUploadedFile } from "./storeUploadedFile";

const bannerTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4"]);

export async function storeBannerUpload(input: {
  bucket: string; file: Express.Multer.File; uploadedBy: string; maxBytes: number;
}) {
  const { bucket, file, uploadedBy, maxBytes } = input;
  const type = file.mimetype.toLowerCase();
  if (!bannerTypes.has(type)) return { ok: false as const, status: 400, error: "invalid_file", message: "Only raster images and MP4 videos are allowed" };
  if (maxBytes > 0 && file.size > maxBytes) return { ok: false as const, status: 413, error: "file_too_large", message: "Banner exceeds the server upload limit" };
  const stored = await storeUploadedFile({ bucket, path: file.path, size: file.size, mimetype: type,
    originalName: file.originalname, uploadedBy, maxBytes, sealed: false, purpose: "banner" });
  return stored.ok ? { ...stored, processing: true } : stored;
}
