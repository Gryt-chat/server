import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { unzipSync } from "fflate";
import { putObject, deleteObject, getObject } from "../storage/s3";
import { insertEmojiJob, listEmojiJobs } from "../db/emojiJobs";
import { insertEmoji, getEmoji, listEmojis, deleteEmoji, renameEmoji } from "../db/emojis";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { getServerRole } from "../db/servers";
import { broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate } from "../socket";
import { DEFAULT_EMOJI_MAX_BYTES, getServerConfig } from "../db/scylla";
import { processEmojiToOptimizedImage } from "../utils/emojiProcessing";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const EMOJI_NAME_RE = /^[A-Za-z0-9_]{2,32}$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
const ZIP_MIME_RE = /^application\/(zip|x-zip|x-zip-compressed)$/;

function deriveEmojiName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/^\d+[-_]/, "");
  const sanitized = base.replace(/[^A-Za-z0-9_]/g, "_");
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
  if (lower === "svg") return "image/svg+xml";
  if (lower === "avif") return "image/avif";
  return "application/octet-stream";
}

export const emojisRouter = express.Router();

emojisRouter.get(
  "/",
  (_req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(async () => {
        const emojis = await listEmojis();
        // Prevent stale emoji lists in browsers/proxies.
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.json(emojis.map((e) => ({ name: e.name, file_id: e.file_id })));
      })
      .catch(next);
  },
);

emojisRouter.get(
  "/queue",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "forbidden", message: "Only admins can view the emoji queue." });
          return;
        }

        const limitRaw = req.query?.limit;
        const limit = typeof limitRaw === "string" ? Number(limitRaw) : 150;
        const jobs = await listEmojiJobs(Number.isFinite(limit) ? limit : 150);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.json({ jobs });
      })
      .catch(next);
  },
);

emojisRouter.post(
  "/stage",
  requireBearerToken,
  upload.fields([{ name: "file", maxCount: 1 }, { name: "files" }]),
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    console.log("[EmojiStage] POST /api/emojis/stage — serverUserId:", serverUserId);
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "s3_not_configured" }); return; }

    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "forbidden", message: "Only admins can upload custom emojis." });
          return;
        }

        const cfg = await getServerConfig().catch(() => null);
        const maxEmojiBytes = cfg?.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES;

        const fileMap = req.files as Record<string, Express.Multer.File[]> | undefined;
        const singleFiles = fileMap?.["file"] || [];
        const batchFiles = fileMap?.["files"] || [];
        const rawFiles = [...singleFiles, ...batchFiles];

        if (rawFiles.length === 0) {
          res.status(400).json({ error: "file_required", message: "At least one image file is required." });
          return;
        }

        let names: string[] = [];
        if (typeof req.body?.names === "string") {
          try {
            const parsed = JSON.parse(req.body.names);
            if (Array.isArray(parsed)) names = parsed.map((n: unknown) => typeof n === "string" ? n.trim() : "");
          } catch {
            res.status(400).json({ error: "invalid_names", message: "names must be a JSON array of strings." });
            return;
          }
        } else if (typeof req.body?.name === "string") {
          names = [req.body.name.trim()];
        }

        type Entry = { buffer: Buffer; mime: string; name: string };
        const entries: Entry[] = [];
        let nameIdx = 0;

        for (const file of rawFiles) {
          const isZip = ZIP_MIME_RE.test(file.mimetype || "") || (file.originalname || "").toLowerCase().endsWith(".zip");
          if (isZip) {
            try {
              const unzipped = unzipSync(new Uint8Array(file.buffer));
              for (const [archivePath, data] of Object.entries(unzipped)) {
                if (archivePath.startsWith("__MACOSX/") || archivePath.endsWith("/")) continue;
                const filename = archivePath.split("/").pop() || archivePath;
                if (!IMAGE_EXT_RE.test(filename)) continue;
                if (data.length === 0 || data.length > maxEmojiBytes) continue;
                const ext = (filename.split(".").pop() || "png").toLowerCase();
                entries.push({ buffer: Buffer.from(data), mime: extToMime(ext), name: deriveEmojiName(filename) });
              }
            } catch (err) {
              console.error("[EmojiStage] Failed to extract zip:", file.originalname, err);
            }
          } else if ((file.mimetype || "").startsWith("image/")) {
            if (file.size === 0 || file.size > maxEmojiBytes) { nameIdx++; continue; }
            entries.push({
              buffer: file.buffer,
              mime: file.mimetype || "image/png",
              name: names[nameIdx] || deriveEmojiName(file.originalname || `emoji_${nameIdx}`),
            });
            nameIdx++;
          } else {
            nameIdx++;
          }
        }

        if (entries.length === 0) {
          res.status(400).json({ error: "no_valid_files", message: "No valid image files found." });
          return;
        }

        // Last wins within the batch.
        const byName = new Map<string, Entry>();
        for (const e of entries) {
          if (byName.has(e.name)) byName.delete(e.name);
          byName.set(e.name, e);
        }
        const deduped = Array.from(byName.values());

        const jobs: Array<
          | { ok: true; job_id: string; name: string; status: "queued" }
          | { ok: false; name: string; error: string; message: string }
        > = [];

        for (const entry of deduped) {
          if (!EMOJI_NAME_RE.test(entry.name)) {
            jobs.push({ ok: false, name: entry.name, error: "invalid_name", message: "Invalid emoji name." });
            continue;
          }

          const jobId = uuidv4();
          const rawKey = `emoji_raw/${jobId}`;
          try {
            await putObject({ bucket, key: rawKey, body: entry.buffer, contentType: entry.mime });
            await insertEmojiJob({
              job_id: jobId,
              name: entry.name,
              raw_s3_key: rawKey,
              raw_content_type: entry.mime,
              raw_bytes: entry.buffer.length,
              uploaded_by_server_user_id: serverUserId,
            });
            jobs.push({ ok: true, job_id: jobId, name: entry.name, status: "queued" });
          } catch (err) {
            console.error("[EmojiStage] Failed to stage emoji:", entry.name, err);
            jobs.push({ ok: false, name: entry.name, error: "stage_failed", message: "Failed to stage emoji." });
          }
        }

        broadcastEmojiQueueUpdate();
        res.status(202).json({ jobs });
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

        const cfg = await getServerConfig().catch(() => null);
        const maxEmojiBytes = cfg?.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES;
        console.log("[EmojiUpload] Emoji max bytes:", maxEmojiBytes);

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
            if (Array.isArray(parsed)) names = parsed.map((n: unknown) => typeof n === "string" ? n.trim() : "");
            console.log("[EmojiUpload] Parsed names from body:", names);
          } catch {
            console.warn("[EmojiUpload] Failed to parse names JSON:", req.body.names);
            res.status(400).json({ error: "invalid_names", message: "names must be a JSON array of strings." });
            return;
          }
        } else if (typeof req.body?.name === "string") {
          names = [req.body.name.trim()];
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
                if (data.length === 0 || data.length > maxEmojiBytes) { console.log("[EmojiUpload] Zip: skipping bad size:", filename, data.length); continue; }
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
          try {
            const existingEmoji = usedNames.has(entry.name) ? await getEmoji(entry.name) : null;
            if (existingEmoji) {
              console.log("[EmojiUpload] Replacing existing emoji:", entry.name);
              await deleteObject({ bucket, key: existingEmoji.s3_key }).catch(() => {});
            }
            console.log("[EmojiUpload] Processing image:", { name: entry.name, mime: entry.mime, bufferSize: entry.buffer.length });
            const { processed, ext, contentType } = await processEmojiToOptimizedImage(entry.buffer, entry.mime.toLowerCase());
            console.log("[EmojiUpload] Sharp resize done:", { name: entry.name, ext, processedSize: processed.length });

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
            broadcastCustomEmojisUpdate();
            res.status(201).json({ name: r.name, file_id: r.file_id });
          } else {
            const status = r.error === "emoji_exists" ? 409 : 400;
            res.status(status).json({ error: r.error, message: r.message });
          }
          return;
        }

        const successCount = results.filter(r => r.ok).length;
        console.log("[EmojiUpload] Batch complete — success:", successCount, "total:", results.length);
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

        const bytes = await body.transformToByteArray();
        res.end(Buffer.from(bytes));
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

/* ─── BetterTTV import ──────────────────────────────────────────────── */

const BTTV_API = "https://api.betterttv.net/3";
const BTTV_CDN = "https://cdn.betterttv.net/emote";

interface BttvEmoteInput {
  id: string;
  code: string;
  imageType: string;
  name: string;
}

emojisRouter.get(
  "/bttv/file/:emoteId",
  (req: Request, res: Response, next: NextFunction): void => {
    const { emoteId } = req.params;
    if (!emoteId || !/^[a-f0-9]{20,30}$/.test(emoteId)) {
      res.status(400).json({ error: "invalid_emote_id" });
      return;
    }

    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxEmojiBytes = cfg?.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES;

        const cdnResp = await fetch(`${BTTV_CDN}/${emoteId}/3x`);
        if (!cdnResp.ok) {
          res.status(cdnResp.status).json({
            error: "bttv_cdn_fetch_failed",
            message: `CDN returned ${cdnResp.status}`,
          });
          return;
        }

        const arrayBuf = await cdnResp.arrayBuffer();
        const bytes = Buffer.from(arrayBuf);

        if (bytes.length > maxEmojiBytes) {
          res.status(413).json({
            error: "emoji_too_large",
            message: `Emoji is larger than max allowed (${maxEmojiBytes} bytes).`,
            bytes: bytes.length,
            maxBytes: maxEmojiBytes,
          });
          return;
        }

        const contentType = cdnResp.headers.get("content-type") ?? "application/octet-stream";
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Length", String(bytes.length));
        res.setHeader("Content-Type", contentType);
        res.end(bytes);
      })
      .catch(next);
  },
);

emojisRouter.get(
  "/bttv/emote/:emoteId",
  (req: Request, res: Response, next: NextFunction): void => {
    const { emoteId } = req.params;
    if (!emoteId || !/^[a-f0-9]{20,30}$/.test(emoteId)) {
      res.status(400).json({ error: "invalid_emote_id" });
      return;
    }

    const tryFetch = async (path: string): Promise<Record<string, unknown> | null> => {
      const resp = await fetch(`${BTTV_API}${path}`);
      if (!resp.ok) return null;
      const json = await resp.json().catch(() => null);
      if (!json || typeof json !== "object") return null;
      return json as Record<string, unknown>;
    };

    Promise.resolve()
      .then(async () => {
        const data =
          (await tryFetch(`/emotes/shared/${emoteId}`)) ??
          (await tryFetch(`/emotes/${emoteId}`));

        if (!data) {
          res.status(404).json({ error: "not_found", message: "BetterTTV emote not found." });
          return;
        }

        const id = typeof data.id === "string" ? data.id : emoteId;
        const code = typeof data.code === "string" ? data.code : "";
        const imageType = typeof data.imageType === "string" ? data.imageType : "png";
        const animated =
          (typeof data.animated === "boolean")
            ? data.animated
            : imageType.toLowerCase() === "gif";

        if (!code) {
          res.status(502).json({ error: "invalid_bttv_response", message: "BetterTTV returned an invalid emote payload." });
          return;
        }

        res.json({
          emote: {
            id,
            code,
            imageType,
            animated,
          },
        });
      })
      .catch(next);
  },
);

emojisRouter.get(
  "/bttv/user/:userId",
  (_req: Request, res: Response, next: NextFunction): void => {
    const { userId } = _req.params;
    if (!userId || !/^[a-f0-9]{20,30}$/.test(userId)) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }

    Promise.resolve()
      .then(async () => {
        const resp = await fetch(`${BTTV_API}/users/${userId}`);
        if (!resp.ok) {
          res.status(resp.status).json({ error: "bttv_fetch_failed", message: `BetterTTV returned ${resp.status}` });
          return;
        }
        const data = await resp.json();
        const channelEmotes = (data.channelEmotes || []).map((e: Record<string, unknown>) => ({
          id: e.id,
          code: e.code,
          imageType: e.imageType,
          animated: e.animated,
        }));
        const sharedEmotes = (data.sharedEmotes || []).map((e: Record<string, unknown>) => ({
          id: e.id,
          code: e.code,
          imageType: e.imageType,
          animated: e.animated,
        }));
        res.json({
          username: data.displayName || data.name,
          channelEmotes,
          sharedEmotes,
        });
      })
      .catch(next);
  },
);

emojisRouter.post(
  "/bttv/import",
  requireBearerToken,
  express.json(),
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "s3_not_configured" }); return; }

    const emotes: BttvEmoteInput[] = req.body?.emotes;
    if (!Array.isArray(emotes) || emotes.length === 0) {
      res.status(400).json({ error: "emotes_required", message: "Provide an array of emotes to import." });
      return;
    }
    Promise.resolve()
      .then(async () => {
        const role = await getServerRole(serverUserId);
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "forbidden", message: "Only admins can import emojis." });
          return;
        }

        const existingEmojis = await listEmojis();
        const usedNames = new Set(existingEmojis.map(e => e.name));
        const results: Array<{ name: string; file_id?: string; ok: boolean; error?: string; message?: string }> = [];

        for (const emote of emotes) {
          const name = emote.name?.trim();
          if (!name || !EMOJI_NAME_RE.test(name)) {
            results.push({ name: name || emote.code, ok: false, error: "invalid_name", message: "Invalid emoji name." });
            continue;
          }
          if (!emote.id || !/^[a-f0-9]{20,30}$/.test(emote.id)) {
            results.push({ name, ok: false, error: "invalid_bttv_id", message: "Invalid BetterTTV emote ID." });
            continue;
          }

          try {
            const existingEmoji = usedNames.has(name) ? await getEmoji(name) : null;
            if (existingEmoji) {
              console.log("[BttvImport] Replacing existing emoji:", name);
              await deleteObject({ bucket, key: existingEmoji.s3_key }).catch(() => {});
            }

            const cdnResp = await fetch(`${BTTV_CDN}/${emote.id}/3x`);
            if (!cdnResp.ok) {
              results.push({ name, ok: false, error: "cdn_fetch_failed", message: `CDN returned ${cdnResp.status}` });
              continue;
            }
            const arrayBuf = await cdnResp.arrayBuffer();
            const imgBuffer = Buffer.from(arrayBuf);

            const sourceMime = emote.imageType === "gif" ? "image/gif"
              : emote.imageType === "webp" ? "image/webp"
              : "image/png";
            const { processed, ext, contentType } = await processEmojiToOptimizedImage(imgBuffer, sourceMime);

            const fileId = uuidv4();
            const key = `emojis/${name}.${ext}`;
            await putObject({ bucket, key, body: processed, contentType });
            await insertEmoji({ name, file_id: fileId, s3_key: key, uploaded_by_server_user_id: serverUserId });

            usedNames.add(name);
            results.push({ name, file_id: fileId, ok: true });
          } catch (err) {
            console.error("[BttvImport] Failed to import emote:", emote.code, err);
            results.push({ name, ok: false, error: "processing_failed", message: "Failed to process image." });
          }
        }

        const successCount = results.filter(r => r.ok).length;
        if (successCount > 0) broadcastCustomEmojisUpdate();
        res.status(successCount > 0 ? 201 : 400).json({ results });
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
              await deleteObject({ bucket, key: emoji.s3_key }).catch(() => {});
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
          await deleteObject({ bucket, key: emoji.s3_key }).catch(() => {});
        }

        await deleteEmoji(name);
        broadcastCustomEmojisUpdate();
        res.json({ ok: true });
      })
      .catch(next);
  },
);
