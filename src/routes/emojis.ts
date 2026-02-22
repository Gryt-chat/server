import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { unzipSync } from "fflate";
import { putObject, deleteObject, getObject } from "../storage/s3";
import { insertEmoji, getEmoji, listEmojis, deleteEmoji } from "../db/emojis";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { getServerRole } from "../db/servers";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 201 } });

const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const ZIP_MIME_RE = /^application\/(zip|x-zip|x-zip-compressed)$/;

function deriveEmojiName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const sanitized = base.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const trimmed = sanitized.replace(/^_+|_+$/g, "").replace(/_{2,}/g, "_");
  if (trimmed.length < 2) return trimmed.padEnd(2, "_");
  return trimmed.slice(0, 32);
}

function extToMime(ext: string): string {
  const lower = ext.toLowerCase();
  if (lower === "jpg" || lower === "jpeg") return "image/jpeg";
  if (lower === "png") return "image/png";
  if (lower === "webp") return "image/webp";
  if (lower === "gif") return "image/gif";
  return "application/octet-stream";
}

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
  upload.fields([{ name: "file", maxCount: 1 }, { name: "files", maxCount: 200 }]),
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    console.log("[EmojiUpload] POST /api/emojis — serverUserId:", serverUserId);
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    const bucket = process.env.S3_BUCKET as string;
    console.log("[EmojiUpload] S3_BUCKET:", bucket ? `"${bucket}"` : "(not set)");
    if (!bucket) { res.status(500).json({ error: "s3_not_configured" }); return; }

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        console.log("[EmojiUpload] User role:", role);
        if (role !== "owner" && role !== "admin") {
          console.warn("[EmojiUpload] Forbidden — role is not owner/admin:", role);
          res.status(403).json({ error: "forbidden", message: "Only admins can upload custom emojis." });
          return;
        }

        const fileMap = req.files as Record<string, Express.Multer.File[]> | undefined;
        const singleFiles = fileMap?.["file"] || [];
        const batchFiles = fileMap?.["files"] || [];
        const rawFiles = [...singleFiles, ...batchFiles];
        const isBatchRequest = batchFiles.length > 0;
        console.log("[EmojiUpload] Files received — single:", singleFiles.length, "batch:", batchFiles.length, "total:", rawFiles.length, "isBatch:", isBatchRequest);

        if (rawFiles.length === 0) {
          console.warn("[EmojiUpload] No files in request");
          res.status(400).json({ error: "file_required", message: "At least one image file is required." });
          return;
        }

        let names: string[] = [];
        if (typeof req.body?.names === "string") {
          try {
            const parsed = JSON.parse(req.body.names);
            if (Array.isArray(parsed)) names = parsed.map((n: unknown) => typeof n === "string" ? n.trim().toLowerCase() : "");
            console.log("[EmojiUpload] Parsed names from body:", names);
          } catch {
            console.warn("[EmojiUpload] Failed to parse names JSON:", req.body.names);
            res.status(400).json({ error: "invalid_names", message: "names must be a JSON array of strings." });
            return;
          }
        } else if (typeof req.body?.name === "string") {
          names = [req.body.name.trim().toLowerCase()];
          console.log("[EmojiUpload] Single name from body:", names[0]);
        } else {
          console.log("[EmojiUpload] No names in body — will derive from filenames");
        }

        type Entry = { buffer: Buffer; mime: string; name: string };
        const entries: Entry[] = [];
        let nameIdx = 0;

        for (const file of rawFiles) {
          const isZip = ZIP_MIME_RE.test(file.mimetype || "") || (file.originalname || "").toLowerCase().endsWith(".zip");
          console.log("[EmojiUpload] Processing file:", { originalname: file.originalname, mimetype: file.mimetype, size: file.size, isZip });
          if (isZip) {
            try {
              const unzipped = unzipSync(new Uint8Array(file.buffer));
              const archivePaths = Object.keys(unzipped);
              console.log("[EmojiUpload] Zip entries:", archivePaths.length);
              for (const [archivePath, data] of Object.entries(unzipped)) {
                if (archivePath.startsWith("__MACOSX/") || archivePath.endsWith("/")) continue;
                const filename = archivePath.split("/").pop() || archivePath;
                if (!IMAGE_EXT_RE.test(filename)) { console.log("[EmojiUpload] Zip: skipping non-image:", filename); continue; }
                if (data.length === 0 || data.length > 5 * 1024 * 1024) { console.log("[EmojiUpload] Zip: skipping bad size:", filename, data.length); continue; }
                const ext = (filename.split(".").pop() || "png").toLowerCase();
                entries.push({ buffer: Buffer.from(data), mime: extToMime(ext), name: deriveEmojiName(filename) });
              }
            } catch (err) {
              console.error("[EmojiUpload] Failed to extract zip:", file.originalname, err);
            }
          } else if ((file.mimetype || "").startsWith("image/")) {
            if (file.size > 5 * 1024 * 1024) { console.warn("[EmojiUpload] Skipping oversized image:", file.originalname, file.size); nameIdx++; continue; }
            entries.push({
              buffer: file.buffer,
              mime: file.mimetype || "image/png",
              name: names[nameIdx] || deriveEmojiName(file.originalname || `emoji_${nameIdx}`),
            });
            nameIdx++;
          } else {
            console.warn("[EmojiUpload] Skipping non-image file:", file.originalname, file.mimetype);
            nameIdx++;
          }
        }

        console.log("[EmojiUpload] Valid entries after parsing:", entries.length, "names:", entries.map(e => e.name));

        if (entries.length === 0) {
          console.warn("[EmojiUpload] No valid image entries found");
          res.status(400).json({ error: "no_valid_files", message: "No valid image files found." });
          return;
        }

        const existingEmojis = await listEmojis();
        const usedNames = new Set(existingEmojis.map(e => e.name));
        console.log("[EmojiUpload] Existing emojis on server:", existingEmojis.length);
        const results: Array<{ name: string; file_id?: string; ok: boolean; error?: string; message?: string }> = [];

        for (const entry of entries) {
          if (!EMOJI_NAME_RE.test(entry.name)) {
            console.warn("[EmojiUpload] Invalid emoji name:", entry.name);
            results.push({ name: entry.name, ok: false, error: "invalid_name", message: "Invalid emoji name." });
            continue;
          }
          if (usedNames.has(entry.name)) {
            console.warn("[EmojiUpload] Emoji already exists:", entry.name);
            results.push({ name: entry.name, ok: false, error: "emoji_exists", message: `":${entry.name}:" already exists.` });
            continue;
          }

          try {
            const isGif = entry.mime.toLowerCase() === "image/gif";
            let processed: Buffer;
            let ext: string;
            let contentType: string;

            console.log("[EmojiUpload] Processing image:", { name: entry.name, mime: entry.mime, isGif, bufferSize: entry.buffer.length });
            if (isGif) {
              processed = await sharp(entry.buffer, { animated: true })
                .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .gif().toBuffer();
              ext = "gif";
              contentType = "image/gif";
            } else {
              processed = await sharp(entry.buffer)
                .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png().toBuffer();
              ext = "png";
              contentType = "image/png";
            }
            console.log("[EmojiUpload] Sharp resize done:", { name: entry.name, processedSize: processed.length });

            const fileId = uuidv4();
            const key = `emojis/${entry.name}.${ext}`;
            console.log("[EmojiUpload] Uploading to S3:", { key, bucket, contentType, size: processed.length });
            await putObject({ bucket, key, body: processed, contentType });
            console.log("[EmojiUpload] S3 upload done:", key);

            console.log("[EmojiUpload] Inserting into DB:", { name: entry.name, fileId, key, serverUserId });
            await insertEmoji({ name: entry.name, file_id: fileId, s3_key: key, uploaded_by_server_user_id: serverUserId });
            console.log("[EmojiUpload] DB insert done:", entry.name);

            usedNames.add(entry.name);
            results.push({ name: entry.name, file_id: fileId, ok: true });
          } catch (err) {
            console.error("[EmojiUpload] Failed to process/upload emoji:", entry.name, err);
            results.push({ name: entry.name, ok: false, error: "processing_failed", message: "Failed to process image." });
          }
        }

        console.log("[EmojiUpload] Results:", JSON.stringify(results));

        if (!isBatchRequest && results.length === 1) {
          const r = results[0];
          if (r.ok) {
            res.status(201).json({ name: r.name, file_id: r.file_id });
          } else {
            const status = r.error === "emoji_exists" ? 409 : 400;
            res.status(status).json({ error: r.error, message: r.message });
          }
          return;
        }

        const successCount = results.filter(r => r.ok).length;
        console.log("[EmojiUpload] Batch complete — success:", successCount, "total:", results.length);
        res.status(successCount > 0 ? 201 : 400).json({ results });
      })
      .catch((err) => {
        console.error("[EmojiUpload] Unhandled error in POST /api/emojis:", err);
        next(err);
      });
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
