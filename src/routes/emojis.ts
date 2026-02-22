import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { putObject, deleteObject, getObject } from "../storage/s3";
import { insertEmoji, getEmoji, listEmojis, deleteEmoji } from "../db/emojis";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { getServerRole } from "../db/servers";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;

export const emojisRouter = express.Router();

emojisRouter.get(
  "/",
  (_req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(async () => {
        const emojis = await listEmojis();
        res.json(emojis.map((e) => ({ name: e.name, file_id: e.file_id })));
      })
      .catch(next);
  },
);

emojisRouter.post(
  "/",
  requireBearerToken as any,
  upload.single("file"),
  (req: Request, res: Response, next: NextFunction): void => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: "file_required", message: "An image file is required." }); return; }

    const name = (typeof req.body?.name === "string" ? req.body.name : "").trim().toLowerCase();
    if (!EMOJI_NAME_RE.test(name)) {
      res.status(400).json({
        error: "invalid_name",
        message: "Emoji name must be 2-32 lowercase alphanumeric characters or underscores.",
      });
      return;
    }

    if (!(file.mimetype || "").startsWith("image/")) {
      res.status(400).json({ error: "invalid_file", message: "Only image files are allowed." });
      return;
    }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "s3_not_configured" }); return; }

    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "forbidden", message: "Only admins can upload custom emojis." });
          return;
        }

        const existing = await getEmoji(name);
        if (existing) {
          res.status(409).json({ error: "emoji_exists", message: `An emoji named :${name}: already exists.` });
          return;
        }

        const isGif = (file.mimetype || "").toLowerCase() === "image/gif";
        let processed: Buffer;
        let ext: string;
        let contentType: string;

        if (isGif) {
          processed = await sharp(file.buffer, { animated: true })
            .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .gif()
            .toBuffer();
          ext = "gif";
          contentType = "image/gif";
        } else {
          processed = await sharp(file.buffer)
            .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
          ext = "png";
          contentType = "image/png";
        }

        const fileId = uuidv4();
        const key = `emojis/${name}.${ext}`;

        await putObject({ bucket, key, body: processed, contentType });
        await insertEmoji({ name, file_id: fileId, s3_key: key, uploaded_by_server_user_id: serverUserId });

        res.status(201).json({ name, file_id: fileId });
      })
      .catch(next);
  },
);

emojisRouter.get(
  "/img/:name",
  (req: Request, res: Response, next: NextFunction): void => {
    const { name } = req.params;
    if (!name) { res.status(400).json({ error: "name_required" }); return; }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "s3_not_configured" }); return; }

    Promise.resolve()
      .then(async () => {
        const emoji = await getEmoji(name);
        if (!emoji) { res.status(404).json({ error: "not_found" }); return; }

        const obj = await getObject({ bucket, key: emoji.s3_key });
        const body: any = (obj as any)?.Body;
        if (!body) { res.status(502).json({ error: "s3_error" }); return; }

        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        const imgContentType = emoji.s3_key.endsWith(".gif") ? "image/gif" : "image/png";
        res.setHeader("Content-Type", imgContentType);

        if (typeof body.pipe === "function") { body.pipe(res); return; }
        if (typeof body.transformToByteArray === "function") {
          const bytes = await body.transformToByteArray();
          res.end(Buffer.from(bytes));
          return;
        }
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) { res.end(Buffer.from(body)); return; }
        res.status(502).json({ error: "s3_error", message: "Unsupported body type" });
      })
      .catch(next);
  },
);

emojisRouter.delete(
  "/:name",
  requireBearerToken as any,
  (req: Request, res: Response, next: NextFunction): void => {
    const name = req.params.name;
    if (!name) { res.status(400).json({ error: "name_required" }); return; }

    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "forbidden", message: "Only admins can delete custom emojis." });
          return;
        }

        const emoji = await getEmoji(name);
        if (!emoji) {
          res.status(404).json({ error: "not_found", message: `Emoji :${name}: not found.` });
          return;
        }

        const bucket = process.env.S3_BUCKET as string;
        if (bucket) {
          await deleteObject({ bucket, key: emoji.s3_key }).catch(() => {});
        }

        await deleteEmoji(name);
        res.json({ ok: true });
      })
      .catch(next);
  },
);
