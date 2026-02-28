import consola from "consola";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { unzipSync } from "fflate";

import { putObject, deleteObject, getObject } from "../storage";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { broadcastCustomEmojisUpdate } from "../socket";
import {
  DEFAULT_EMOJI_MAX_BYTES,
  deleteEmoji,
  getEmoji,
  getServerConfig,
  getServerRole,
  insertEmoji,
  listEmojis,
  renameEmoji,
} from "../db";
import { processEmojiToOptimizedImage } from "../utils/emojiProcessing";
import {
  upload,
  EMOJI_NAME_RE,
  IMAGE_EXT_RE,
  ZIP_MIME_RE,
  deriveEmojiName,
  extToMime,
} from "./emojiShared";
import { registerStagingRoutes } from "./emojiStaging";
import { registerBttvRoutes } from "./emojiBttvImport";

export const emojisRouter = express.Router();

registerStagingRoutes(emojisRouter);
registerBttvRoutes(emojisRouter);

emojisRouter.get(
  "/",
  (_req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(async () => {
        const emojis = await listEmojis();
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.json(emojis.map((e) => ({ name: e.name, file_id: e.file_id })));
      })
      .catch(next);
  },
);

emojisRouter.post(
  "/",
  requireBearerToken,
  upload.fields([{ name: "file", maxCount: 1 }, { name: "files" }]),
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    consola.debug("[EmojiUpload] POST /api/emojis — serverUserId:", serverUserId);
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    const bucket = process.env.S3_BUCKET as string;
    consola.debug("[EmojiUpload] S3_BUCKET:", bucket ? `"${bucket}"` : "(not set)");
    if (!bucket) { res.status(500).json({ error: "s3_not_configured" }); return; }

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        consola.debug("[EmojiUpload] User role:", role);
        if (role !== "owner" && role !== "admin") {
          console.warn("[EmojiUpload] Forbidden — role is not owner/admin:", role);
          res.status(403).json({ error: "forbidden", message: "Only admins can upload custom emojis." });
          return;
        }

        const cfg = await getServerConfig().catch(() => null);
        const maxEmojiBytes = cfg?.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES;
        consola.debug("[EmojiUpload] Emoji max bytes:", maxEmojiBytes);

        const fileMap = req.files as Record<string, Express.Multer.File[]> | undefined;
        const singleFiles = fileMap?.["file"] || [];
        const batchFiles = fileMap?.["files"] || [];
        const rawFiles = [...singleFiles, ...batchFiles];
        const isBatchRequest = batchFiles.length > 0;
        consola.debug("[EmojiUpload] Files received — single:", singleFiles.length, "batch:", batchFiles.length, "total:", rawFiles.length, "isBatch:", isBatchRequest);

        if (rawFiles.length === 0) {
          console.warn("[EmojiUpload] No files in request");
          res.status(400).json({ error: "file_required", message: "At least one image file is required." });
          return;
        }

        let names: string[] = [];
        if (typeof req.body?.names === "string") {
          try {
            const parsed = JSON.parse(req.body.names);
            if (Array.isArray(parsed)) names = parsed.map((n: unknown) => typeof n === "string" ? n.trim() : "");
            consola.debug("[EmojiUpload] Parsed names from body:", names);
          } catch {
            console.warn("[EmojiUpload] Failed to parse names JSON:", req.body.names);
            res.status(400).json({ error: "invalid_names", message: "names must be a JSON array of strings." });
            return;
          }
        } else if (typeof req.body?.name === "string") {
          names = [req.body.name.trim()];
          consola.debug("[EmojiUpload] Single name from body:", names[0]);
        } else {
          consola.debug("[EmojiUpload] No names in body — will derive from filenames");
        }

        type Entry = { buffer: Buffer; mime: string; name: string };
        const entries: Entry[] = [];
        let nameIdx = 0;

        for (const file of rawFiles) {
          const isZip = ZIP_MIME_RE.test(file.mimetype || "") || (file.originalname || "").toLowerCase().endsWith(".zip");
          consola.debug("[EmojiUpload] Processing file:", { originalname: file.originalname, mimetype: file.mimetype, size: file.size, isZip });
          if (isZip) {
            try {
              const unzipped = unzipSync(new Uint8Array(file.buffer));
              const archivePaths = Object.keys(unzipped);
              consola.debug("[EmojiUpload] Zip entries:", archivePaths.length);
              for (const [archivePath, data] of Object.entries(unzipped)) {
                if (archivePath.startsWith("__MACOSX/") || archivePath.endsWith("/")) continue;
                const filename = archivePath.split("/").pop() || archivePath;
                if (!IMAGE_EXT_RE.test(filename)) { consola.debug("[EmojiUpload] Zip: skipping non-image:", filename); continue; }
                if (data.length === 0 || data.length > maxEmojiBytes) { consola.debug("[EmojiUpload] Zip: skipping bad size:", filename, data.length); continue; }
                const ext = (filename.split(".").pop() || "png").toLowerCase();
                entries.push({ buffer: Buffer.from(data), mime: extToMime(ext), name: deriveEmojiName(filename) });
              }
            } catch (err) {
              console.error("[EmojiUpload] Failed to extract zip:", file.originalname, err);
            }
          } else if ((file.mimetype || "").startsWith("image/")) {
            if (file.size > maxEmojiBytes) { console.warn("[EmojiUpload] Skipping oversized image:", file.originalname, file.size); nameIdx++; continue; }
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

        consola.debug("[EmojiUpload] Valid entries after parsing:", entries.length, "names:", entries.map(e => e.name));

        if (entries.length === 0) {
          console.warn("[EmojiUpload] No valid image entries found");
          res.status(400).json({ error: "no_valid_files", message: "No valid image files found." });
          return;
        }

        const existingEmojis = await listEmojis();
        const usedNames = new Set(existingEmojis.map(e => e.name));
        consola.debug("[EmojiUpload] Existing emojis on server:", existingEmojis.length);
        const results: Array<{ name: string; file_id?: string; ok: boolean; error?: string; message?: string }> = [];

        for (const entry of entries) {
          if (!EMOJI_NAME_RE.test(entry.name)) {
            console.warn("[EmojiUpload] Invalid emoji name:", entry.name);
            results.push({ name: entry.name, ok: false, error: "invalid_name", message: "Invalid emoji name." });
            continue;
          }
          try {
            const existingEmoji = usedNames.has(entry.name) ? await getEmoji(entry.name) : null;
            if (existingEmoji) {
              consola.debug("[EmojiUpload] Replacing existing emoji:", entry.name);
              await deleteObject({ bucket, key: existingEmoji.s3_key }).catch((e) => consola.warn("S3 delete failed", e));
            }
            consola.debug("[EmojiUpload] Processing image:", { name: entry.name, mime: entry.mime, bufferSize: entry.buffer.length });
            const { processed, ext, contentType } = await processEmojiToOptimizedImage(entry.buffer, entry.mime.toLowerCase());
            consola.debug("[EmojiUpload] Sharp resize done:", { name: entry.name, ext, processedSize: processed.length });

            const fileId = uuidv4();
            const key = `emojis/${entry.name}.${ext}`;
            consola.debug("[EmojiUpload] Uploading to S3:", { key, bucket, contentType, size: processed.length });
            await putObject({ bucket, key, body: processed, contentType });
            consola.debug("[EmojiUpload] S3 upload done:", key);

            consola.debug("[EmojiUpload] Inserting into DB:", { name: entry.name, fileId, key, serverUserId });
            await insertEmoji({ name: entry.name, file_id: fileId, s3_key: key, uploaded_by_server_user_id: serverUserId });
            consola.debug("[EmojiUpload] DB insert done:", entry.name);

            usedNames.add(entry.name);
            results.push({ name: entry.name, file_id: fileId, ok: true });
          } catch (err) {
            console.error("[EmojiUpload] Failed to process/upload emoji:", entry.name, err);
            results.push({ name: entry.name, ok: false, error: "processing_failed", message: "Failed to process image." });
          }
        }

        consola.debug("[EmojiUpload] Results:", JSON.stringify(results));

        if (!isBatchRequest && results.length === 1) {
          const r = results[0];
          if (r.ok) {
            broadcastCustomEmojisUpdate();
            res.status(201).json({ name: r.name, file_id: r.file_id });
          } else {
            const status = r.error === "emoji_exists" ? 409 : 400;
            res.status(status).json({ error: r.error, message: r.message });
          }
          return;
        }

        const successCount = results.filter(r => r.ok).length;
        consola.debug("[EmojiUpload] Batch complete — success:", successCount, "total:", results.length);
        if (successCount > 0) broadcastCustomEmojisUpdate();
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
        const body = obj.Body;
        if (!body) { res.status(502).json({ error: "s3_error" }); return; }

        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        const key = emoji.s3_key.toLowerCase();
        const imgContentType = key.endsWith(".avif") ? "image/avif"
          : key.endsWith(".gif") ? "image/gif"
          : key.endsWith(".svg") ? "image/svg+xml"
          : key.endsWith(".webp") ? "image/webp"
          : key.endsWith(".jpg") || key.endsWith(".jpeg") ? "image/jpeg"
          : "image/png";
        res.setHeader("Content-Type", imgContentType);

        body.pipe(res);
      })
      .catch(next);
  },
);

emojisRouter.patch(
  "/:name",
  requireBearerToken,
  express.json(),
  (req: Request, res: Response, next: NextFunction): void => {
    const oldName = req.params.name;
    const newName = typeof req.body?.name === "string" ? req.body.name.trim() : "";

    if (!oldName) { res.status(400).json({ error: "name_required" }); return; }
    if (!newName || !EMOJI_NAME_RE.test(newName)) {
      res.status(400).json({ error: "invalid_name", message: "Name must be 2-32 letters (case-sensitive), numbers, or underscores." });
      return;
    }
    if (oldName === newName) { res.json({ ok: true, name: newName }); return; }

    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "forbidden", message: "Only admins can rename custom emojis." });
          return;
        }

        const existing = await getEmoji(oldName);
        if (!existing) {
          res.status(404).json({ error: "not_found", message: `Emoji :${oldName}: not found.` });
          return;
        }

        const conflict = await getEmoji(newName);
        if (conflict) {
          res.status(409).json({ error: "emoji_exists", message: `":${newName}:" already exists.` });
          return;
        }

        await renameEmoji(oldName, newName);
        broadcastCustomEmojisUpdate();
        res.json({ ok: true, name: newName });
      })
      .catch(next);
  },
);

emojisRouter.delete(
  "/all",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    const bucket = process.env.S3_BUCKET as string;

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "forbidden", message: "Only admins can delete emojis." });
          return;
        }

        const allEmojis = await listEmojis();
        if (allEmojis.length === 0) {
          res.json({ ok: true, deleted: 0 });
          return;
        }

        let deleted = 0;
        for (const emoji of allEmojis) {
          try {
            if (bucket) {
              await deleteObject({ bucket, key: emoji.s3_key }).catch((e) => consola.warn("S3 delete failed", e));
            }
            await deleteEmoji(emoji.name);
            deleted++;
          } catch (err) {
            console.error("[EmojiDeleteAll] Failed to delete:", emoji.name, err);
          }
        }

        if (deleted > 0) broadcastCustomEmojisUpdate();
        res.json({ ok: true, deleted });
      })
      .catch(next);
  },
);

emojisRouter.delete(
  "/:name",
  requireBearerToken,
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
          await deleteObject({ bucket, key: emoji.s3_key }).catch((e) => consola.warn("S3 delete failed", e));
        }

        await deleteEmoji(name);
        broadcastCustomEmojisUpdate();
        res.json({ ok: true });
      })
      .catch(next);
  },
);
