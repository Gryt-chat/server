import multer from "multer";

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const EMOJI_NAME_RE = /^[A-Za-z0-9_]{2,32}$/;
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
export const ZIP_MIME_RE = /^application\/(zip|x-zip|x-zip-compressed)$/;

export function deriveEmojiName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/^\d+[-_]/, "");
  const sanitized = base.replace(/[^A-Za-z0-9_]/g, "_");
  const trimmed = sanitized.replace(/^_+|_+$/g, "").replace(/_{2,}/g, "_");
  if (trimmed.length < 2) return trimmed.padEnd(2, "_");
  return trimmed.slice(0, 32);
}

export function extToMime(ext: string): string {
  const lower = ext.toLowerCase();
  if (lower === "jpg" || lower === "jpeg") return "image/jpeg";
  if (lower === "png") return "image/png";
  if (lower === "webp") return "image/webp";
  if (lower === "gif") return "image/gif";
  if (lower === "svg") return "image/svg+xml";
  if (lower === "avif") return "image/avif";
  return "application/octet-stream";
}
