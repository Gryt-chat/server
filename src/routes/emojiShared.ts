import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { DEFAULT_EMOJI_MAX_BYTES, getServerConfig } from "../db";

/**
 * The server's own limit, which a fixed one could be raised past. The zero check
 * below is for a zero written straight into the row.
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
// SVG is deliberately absent: validateImage refuses it, so unpacking one only
// produced an entry that failed a step later.
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
