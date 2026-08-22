import consola from "consola";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

import { deleteObject, putObject } from "../storage";
import {
  createServerConfigIfNotExists,
  getServerConfig,
  insertServerAudit,
  updateServerConfig,
} from "../db";
import { broadcastServerUiUpdate } from "../socket";
import { MAX_INPUT_PIXELS, validateImage } from "../utils/imageValidation";
import { sanitizeSvg } from "../utils/svgSanitize";
import { verifyAccessToken } from "../utils/jwt";

const iconMaxMbRaw = (
  process.env.GRYT_SERVER_ICON_MAX_MB ||
  process.env.SERVER_ICON_MAX_MB ||
  "25"
).trim();
const iconMaxMb = Number.isFinite(Number(iconMaxMbRaw))
  ? Math.max(1, Number(iconMaxMbRaw))
  : 25;
const iconMaxBytes = Math.floor(iconMaxMb * 1024 * 1024);

const allowedIconMimes = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: iconMaxBytes },
  fileFilter: (_req, file, cb) => {
    if (allowedIconMimes.has(file.mimetype)) return cb(null, true);
    cb(
      new Error(
        `Unsupported icon format (${
          file.mimetype || "unknown"
        }). Allowed: PNG, JPEG, WebP, GIF, AVIF.`
      )
    );
  },
});

/**
 * Drop the object an icon used to live in.
 *
 * Best effort: the config has already been updated by the time this runs, so
 * the icon is gone as far as anyone using the server is concerned. Failing to
 * delete leaves a few kilobytes behind, which is not worth failing the request
 * the owner actually made.
 *
 * Neither replacing nor clearing used to do this, so every icon a server had
 * ever had stayed in the bucket for good.
 */
function deletePreviousIcon(bucket: string, key: string | null | undefined): void {
  if (!key) return;
  deleteObject({ bucket, key }).catch((e) =>
    consola.warn("previous icon delete failed", { key, error: e }),
  );
}

export const serverRouter = express.Router();

function getBearerToken(req: Request): string | null {
  const h = req.headers["authorization"];
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function sanitizeStoragePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
}

serverRouter.post(
  "/icon",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        res.status(401).json({
          error: "auth_required",
          message: "Missing Authorization bearer token",
        });
        return;
      }

      const decoded = verifyAccessToken(token);
      if (!decoded) {
        res
          .status(401)
          .json({ error: "token_invalid", message: "Invalid access token" });
        return;
      }

      const host = req.headers.host || "unknown";
      if (decoded.serverHost !== host) {
        res.status(403).json({
          error: "forbidden",
          message: "Invalid token for this server",
        });
        return;
      }

      const safeHost = sanitizeStoragePathSegment(host);

      await createServerConfigIfNotExists();
      const cfg = await getServerConfig();
      if (!cfg?.owner_gryt_user_id) {
        res.status(409).json({
          error: "no_owner",
          message: "Server has no owner configured",
        });
        return;
      }
      if (cfg.owner_gryt_user_id !== decoded.grytUserId) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the server owner can change the icon",
        });
        return;
      }

      const file = req.file;
      if (!file) {
        res
          .status(400)
          .json({ error: "file_required", message: "file is required" });
        return;
      }

      const bucket = process.env.S3_BUCKET as string;
      const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";
      if (disableS3) {
        res.status(503).json({
          error: "s3_disabled",
          message:
            "S3 is disabled (DISABLE_S3=true). Icon upload is unavailable.",
        });
        return;
      }
      if (!bucket) {
        res.status(500).json({
          error: "s3_not_configured",
          message: "S3_BUCKET not configured",
        });
        return;
      }

      const iconMime = (file.mimetype || "").toLowerCase();

      // SVG is stored as the vector it is rather than rendered to a raster.
      // An icon is drawn at a handful of sizes and a vector is correct at all
      // of them, in one file of a couple of kilobytes. It never reaches sharp,
      // so librsvg never parses a stranger's bytes — see utils/svgSanitize.ts.
      if (iconMime === "image/svg+xml") {
        const svg = sanitizeSvg(file.buffer);
        if (!svg.valid) {
          res.status(400).json({ error: "invalid_file", message: svg.reason });
          return;
        }

        const body = Buffer.from(svg.svg, "utf8");
        const svgKey = `server-icons/${safeHost}/${uuidv4()}.svg`;
        try {
          await putObject({ bucket, key: svgKey, body, contentType: "image/svg+xml" });
        } catch (e) {
          const raw = e instanceof Error ? e.message : "";
          consola.error("icon upload s3 error", { bucket, key: svgKey, message: raw });
          res.status(502).json({ error: "s3_error", message: "Icon upload failed due to a storage error." });
          return;
        }

        const previousSvgIcon = cfg?.icon_url ?? null;
        const updatedSvg = await updateServerConfig({
          iconUrl: svgKey,
          isConfigured: true,
        });
        deletePreviousIcon(bucket, previousSvgIcon);

        insertServerAudit({
          actorServerUserId: decoded.serverUserId,
          action: "icon_update",
          target: svgKey,
        }).catch((e) => consola.warn("audit log write failed", e));

        res.status(201).json({
          ok: true,
          iconKey: svgKey,
          iconUrl: updatedSvg.icon_url,
        });
        return;
      }

      const isAnimated =
        iconMime === "image/gif" ||
        iconMime === "image/webp" ||
        iconMime === "image/avif";

      const validation = await validateImage(file.buffer, {
        animated: isAnimated,
      });
      if (!validation.valid) {
        res
          .status(400)
          .json({ error: "invalid_file", message: validation.reason });
        return;
      }

      // AVIF cannot hold more than one frame. sharp represents an animated
      // image as its frames stacked into one tall strip, so encoding an
      // animated input to AVIF writes the whole strip out as a single still —
      // a 95-frame GIF became a 256x9728 image that the UI then squashed into
      // the icon slot, showing every frame at once. Long enough animations
      // failed outright with "heifsave: image too large".
      //
      // WebP holds animation, so animated input goes there instead. This is the
      // same branch emojiProcessing.ts already makes; the icon route was the
      // only place that read every frame and then chose a format that cannot
      // store them.
      const outMime = isAnimated ? "image/webp" : "image/avif";
      const outExt = isAnimated ? "webp" : "avif";

      let out: Buffer;
      try {
        const pipeline = sharp(file.buffer, {
          animated: isAnimated,
          failOn: "error",
          // validateImage above pixel-checks a single page, because that is
          // what it decodes. This call decodes every frame — sharp stacks an
          // animation into one tall strip — so the budget has to be carried
          // here too, and it is animated input where it matters most: a
          // modest frame is under the ceiling on its own and two hundred of
          // them are not.
          limitInputPixels: MAX_INPUT_PIXELS,
        }).resize(256, 256, { fit: "cover" });

        out = isAnimated
          ? await pipeline.webp().toBuffer()
          : await pipeline.avif().toBuffer();
      } catch {
        res.status(400).json({
          error: "invalid_file",
          message:
            "Could not process image. Please upload a valid PNG/JPEG/WebP/GIF/AVIF under the size limit.",
        });
        return;
      }

      const key = `server-icons/${safeHost}/${uuidv4()}.${outExt}`;
      try {
        await putObject({ bucket, key, body: out, contentType: outMime });
      } catch (e) {
        const raw = e instanceof Error ? e.message : "";
        consola.error("icon upload s3 error", { bucket, key, message: raw });
        const friendly = /InvalidBucketName|NoSuchBucket|bucket/i.test(raw)
          ? "File storage is misconfigured on this server. Please contact the server administrator."
          : /AccessDenied|Forbidden/i.test(raw)
          ? "File storage access denied. Please contact the server administrator."
          : raw.trim().length > 0
          ? `Icon upload failed: ${raw}`
          : "Icon upload failed due to a storage error.";
        res.status(502).json({ error: "s3_error", message: friendly });
        return;
      }

      const previousIcon = cfg?.icon_url ?? null;
      const updated = await updateServerConfig({
        iconUrl: key, // stored as S3 key; GET /icon streams the object
        isConfigured: true,
      });
      deletePreviousIcon(bucket, previousIcon);

      insertServerAudit({
        actorServerUserId: decoded.serverUserId,
        action: "icon_update",
        target: key,
      }).catch((e) => consola.warn("audit log write failed", e));

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

serverRouter.delete(
  "/icon",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        res.status(401).json({
          error: "auth_required",
          message: "Missing Authorization bearer token",
        });
        return;
      }

      const decoded = verifyAccessToken(token);
      if (!decoded) {
        res
          .status(401)
          .json({ error: "token_invalid", message: "Invalid access token" });
        return;
      }

      const host = req.headers.host || "unknown";
      if (decoded.serverHost !== host) {
        res.status(403).json({
          error: "forbidden",
          message: "Invalid token for this server",
        });
        return;
      }

      await createServerConfigIfNotExists();
      const cfg = await getServerConfig();
      if (!cfg?.owner_gryt_user_id) {
        res.status(409).json({
          error: "no_owner",
          message: "Server has no owner configured",
        });
        return;
      }
      if (cfg.owner_gryt_user_id !== decoded.grytUserId) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the server owner can change the icon",
        });
        return;
      }

      const prev = cfg.icon_url || null;
      if (!prev) {
        res.status(200).json({ ok: true, cleared: false });
        return;
      }

      await updateServerConfig({
        iconUrl: null,
        isConfigured: true,
      });

      if (process.env.S3_BUCKET) deletePreviousIcon(process.env.S3_BUCKET, prev);

      insertServerAudit({
        actorServerUserId: decoded.serverUserId,
        action: "icon_clear",
        target: prev,
      }).catch((e) => consola.warn("audit log write failed", e));

      res.status(200).json({ ok: true, cleared: true });

      broadcastServerUiUpdate("icon");
    } catch (e) {
      next(e);
    }
  }
);
