import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { DEFAULT_EMOJI_MAX_BYTES, getServerConfig } from "../db";

/**
 * multer for the two emoji upload routes, enforcing the server's own limit.
 *
 * This used to be a fixed 50 MB, while `emojiMaxBytes` could be set anywhere up
 * to 200 MB — the same two-ceilings bug `uploadToDisk` in `uploads.ts` had, and
 * with the same result: the lower one won and nothing said so. An owner who
 * raised the setting past 50 MB got a request that died in multer with a
 * generic error instead of the size check that has something useful to say.
 *
 * Memory storage rather than disk, for the reason `uploads.ts` gives about
 * avatars: every emoji is re-encoded through sharp immediately, so a temp file
 * would be written and deleted for nothing. That is also why emoji do not get
 * the upload route's unlimited option: `clampBytes` holds this setting to a
 * 64 KB floor and a 200 MB ceiling, so zero is not reachable through settings
 * at all. The check below is for a zero written straight into the row, where
 * `{ fileSize: 0 }` would otherwise refuse every upload.
 */
export function emojiUpload(fields: multer.Field[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = typeof cfg?.emoji_max_bytes === "number" ? cfg.emoji_max_bytes : DEFAULT_EMOJI_MAX_BYTES;
        const limits = maxBytes > 0 ? { fileSize: maxBytes } : undefined;
        multer({ storage: multer.memoryStorage(), limits }).fields(fields)(req, res, next);
      })
      .catch(next);
  };
}

export const EMOJI_NAME_RE = /^[A-Za-z0-9_]{2,32}$/;
// SVG is deliberately absent. validateImage refuses it, so a .svg inside a ZIP
// used to be unpacked into an entry that failed one step later with a
// per-file error. Skipping it here means there is nothing to report.
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
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
  if (lower === "avif") return "image/avif";
  return "application/octet-stream";
}
