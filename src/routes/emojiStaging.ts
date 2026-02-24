import consola from "consola";
import type { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { unzipSync } from "fflate";

import { putObject } from "../storage/s3";
import { insertEmojiJob, listEmojiJobs } from "../db/emojiJobs";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { getServerRole } from "../db/servers";
import { broadcastEmojiQueueUpdate } from "../socket";
import { DEFAULT_EMOJI_MAX_BYTES, getServerConfig } from "../db/scylla";
import {
  upload,
  EMOJI_NAME_RE,
  IMAGE_EXT_RE,
  ZIP_MIME_RE,
  deriveEmojiName,
  extToMime,
} from "./emojiShared";

export function registerStagingRoutes(router: Router): void {
  router.get(
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

  router.post(
    "/stage",
    requireBearerToken,
    upload.fields([{ name: "file", maxCount: 1 }, { name: "files" }]),
    (req: Request, res: Response, next: NextFunction): void => {
      const serverUserId = req.tokenPayload?.serverUserId;
      consola.debug("[EmojiStage] POST /api/emojis/stage — serverUserId:", serverUserId);
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
}
