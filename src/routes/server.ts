import consola from "consola";
import { deletePreviousIcon, saveRasterServerIcon } from "../services/serverIcon";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";

import { putObject, STORAGE_DISABLED, uploadsDisabled, uploadsFolder } from "../storage";
import {
  createServerConfigIfNotExists,
  getServerConfig,
  insertServerAudit,
  updateServerConfig,
} from "../db";
import { broadcastServerUiUpdate } from "../socket";
import { sanitizeSvg } from "../utils/svgSanitize";
import { verifyAccessToken } from "../utils/jwt";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { refusedForStorage } from "../settings/storageLimit";

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
  // Before multer, which uses memoryStorage: the handler's own check read 20 MB
  // of an anonymous request into the heap and then answered 401.
  requireBearerToken,
  (_req: Request, res: Response, next: NextFunction): void => {
    refusedForStorage(res).then((refused) => { if (!refused) next(); }).catch(next);
  },
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

      const bucket = uploadsFolder();
      if (uploadsDisabled()) {
        res.status(503).json(STORAGE_DISABLED);
        return;
      }

      const iconMime = (file.mimetype || "").toLowerCase();

      // Stored as the vector, which is correct at every size an icon is drawn
      // at. It never reaches sharp, so librsvg never parses a stranger's bytes.
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

      const saved = await saveRasterServerIcon(file.buffer, iconMime, safeHost, decoded.serverUserId);
      if (!saved.ok) {
        res.status(saved.status).json({ error: saved.error, message: saved.message });
        return;
      }

      res.status(201).json({
        ok: true,
        iconKey: saved.key,
        // For convenience; clients should still use https://<host>/icon
        iconUrl: saved.iconUrl,
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
  requireBearerToken,
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

      deletePreviousIcon(uploadsFolder(), prev);

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
