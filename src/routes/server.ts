import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

import { putObject } from "../storage/s3";
import {
  createServerConfigIfNotExists,
  getServerConfig,
  insertServerAudit,
  updateServerConfig,
} from "../db/scylla";
import { broadcastServerUiUpdate } from "../socket";
import { verifyAccessToken } from "../utils/jwt";

const iconMaxMbRaw = (process.env.GRYT_SERVER_ICON_MAX_MB || process.env.SERVER_ICON_MAX_MB || "25").trim();
const iconMaxMb = Number.isFinite(Number(iconMaxMbRaw)) ? Math.max(1, Number(iconMaxMbRaw)) : 25;
const iconMaxBytes = Math.floor(iconMaxMb * 1024 * 1024);

const allowedIconMimes = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: iconMaxBytes },
  fileFilter: (_req, file, cb) => {
    if (allowedIconMimes.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported icon format (${file.mimetype || "unknown"}). Allowed: PNG, JPEG, WebP, GIF, AVIF.`));
  },
});

export const serverRouter = express.Router();

function getBearerToken(req: Request): string | null {
  const h = req.headers["authorization"];
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

serverRouter.post(
  "/icon",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        res.status(401).json({ error: "auth_required", message: "Missing Authorization bearer token" });
        return;
      }

      const decoded = verifyAccessToken(token);
      if (!decoded) {
        res.status(401).json({ error: "token_invalid", message: "Invalid access token" });
        return;
      }

      const host = req.headers.host || "unknown";
      if (decoded.serverHost !== host) {
        res.status(403).json({ error: "forbidden", message: "Invalid token for this server" });
        return;
      }

      await createServerConfigIfNotExists();
      const cfg = await getServerConfig();
      if (!cfg?.owner_gryt_user_id) {
        res.status(409).json({ error: "no_owner", message: "Server has no owner configured" });
        return;
      }
      if (cfg.owner_gryt_user_id !== decoded.grytUserId) {
        res.status(403).json({ error: "forbidden", message: "Only the server owner can change the icon" });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "file_required", message: "file is required" });
        return;
      }

      const bucket = process.env.S3_BUCKET as string;
      const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";
      if (disableS3) {
        res.status(503).json({ error: "s3_disabled", message: "S3 is disabled (DISABLE_S3=true). Icon upload is unavailable." });
        return;
      }
      if (!bucket) {
        res.status(500).json({ error: "s3_not_configured", message: "S3_BUCKET not configured" });
        return;
      }

      const isGif = (file.mimetype || "").toLowerCase() === "image/gif";
      let out: Buffer;
      let outMime: string;
      let outExt: string;
      try {
        if (isGif) {
          out = await sharp(file.buffer, { animated: true })
            .resize(256, 256, { fit: "cover" })
            .gif()
            .toBuffer();
          outMime = "image/gif";
          outExt = "gif";
        } else {
          out = await sharp(file.buffer)
            .resize(256, 256, { fit: "cover" })
            .png({ compressionLevel: 9 })
            .toBuffer();
          outMime = "image/png";
          outExt = "png";
        }
      } catch {
        res.status(400).json({ error: "invalid_file", message: "Could not process image. Please upload a valid PNG/JPEG/WebP/GIF/AVIF under the size limit." });
        return;
      }

      const key = `server-icons/${host}/${uuidv4()}.${outExt}`;
      try {
        await putObject({ bucket, key, body: out, contentType: outMime });
      } catch (e) {
        const msg =
          (e instanceof Error && e.message.trim().length > 0)
            ? e.message
            : "S3 upload failed.";
        res.status(502).json({ error: "s3_error", message: msg });
        return;
      }

      const updated = await updateServerConfig({
        iconUrl: key, // stored as S3 key; GET /icon streams the object
        isConfigured: true,
      });

      insertServerAudit({
        actorServerUserId: decoded.serverUserId,
        action: "icon_update",
        target: key,
      }).catch(() => undefined);

      res.status(201).json({
        ok: true,
        iconKey: key,
        // For convenience; clients should still use https://<host>/icon
        iconUrl: updated.icon_url,
      });

      // Push refreshed info/details to all connected sockets so UI updates live.
      broadcastServerUiUpdate("icon");
    } catch (e) {
      next(e);
    }
  }
);

