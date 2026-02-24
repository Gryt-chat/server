import consola from "consola";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import mime from "mime-types";
import sharp from "sharp";
import { Readable } from "stream";
import { execFile } from "child_process";
import { writeFile, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { putObject, getObject } from "../storage/s3";
import { insertFile, getFile, updateUserAvatar, setUserAvatar, getServerConfig, DEFAULT_AVATAR_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES } from "../db/scylla";
import { requireBearerToken } from "../middleware/requireBearerToken";

async function extractVideoThumbnail(buffer: Buffer, fileId: string): Promise<Buffer | null> {
  const inputPath = join(tmpdir(), `gryt-vid-${fileId}`);
  const outputPath = join(tmpdir(), `gryt-thumb-${fileId}.jpg`);
  try {
    await writeFile(inputPath, buffer);
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", [
        "-i", inputPath,
        "-ss", "00:00:01",
        "-vframes", "1",
        "-vf", "scale=320:-1",
        "-q:v", "5",
        "-y", outputPath,
      ], { timeout: 15000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return await readFile(outputPath);
  } catch {
    return null;
  } finally {
    await unlink(inputPath).catch((e) => consola.warn("temp file cleanup failed", e));
    await unlink(outputPath).catch((e) => consola.warn("temp file cleanup failed", e));
  }
}

// Absolute cap; server-configured limits apply per request.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

export const uploadsRouter = express.Router();

uploadsRouter.post(
  "/",
  requireBearerToken,
  upload.single("file"),
  (req: Request, res: Response, next: NextFunction): void => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) {
      res.status(500).json({ error: "S3_BUCKET not configured" });
      return;
    }

    const fileId = uuidv4();
    const fileMime = (file.mimetype || "").toLowerCase();
    const isImage = fileMime.startsWith("image/");
    const isVideo = fileMime.startsWith("video/");
    const isAnimatedSource = fileMime === "image/gif" || fileMime === "image/webp" || fileMime === "image/avif";

    const ext = isImage ? "avif" : (mime.extension(file.mimetype || "") || "bin");
    const key = `uploads/${fileId}.${ext}`;

    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES);
        if (typeof maxBytes === "number" && maxBytes > 0 && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `File too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        let storedBody: Buffer = file.buffer;
        let storedMime: string = file.mimetype || "application/octet-stream";
        let storedSize: number = file.size;
        let thumbKey: string | null = null;
        let width: number | null = null;
        let height: number | null = null;

        if (isImage) {
          const meta = await sharp(file.buffer, { animated: isAnimatedSource }).metadata().catch(() => null);
          if (meta?.width && meta?.height) { width = meta.width; height = meta.height; }
          storedBody = await sharp(file.buffer, { animated: isAnimatedSource })
            .avif()
            .toBuffer();
          storedMime = "image/avif";
          storedSize = storedBody.length;
          const thumb = await sharp(file.buffer, { animated: isAnimatedSource })
            .resize({ width: 320, withoutEnlargement: true })
            .avif({ quality: 50 })
            .toBuffer();
          thumbKey = `thumbnails/${fileId}.avif`;
          await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/avif" });
        }

        await putObject({ bucket, key, body: storedBody, contentType: storedMime });

        if (isVideo) {
          const thumb = await extractVideoThumbnail(file.buffer, fileId);
          if (thumb) {
            thumbKey = `thumbnails/${fileId}.jpg`;
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/jpeg" }).catch(() => { thumbKey = null; });
          }
        }

        await insertFile({
          file_id: fileId,
          s3_key: key,
          mime: storedMime,
          size: storedSize,
          width,
          height,
          thumbnail_key: thumbKey,
          original_name: file.originalname || null,
          created_at: new Date(),
        });
        res.status(201).json({ fileId, key, thumbnailKey: thumbKey });
      })
      .catch(next);
  },
);

uploadsRouter.post(
  "/avatar",
  requireBearerToken,
  upload.single("file"),
  (req: Request, res: Response, next: NextFunction): void => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: "file_required", message: "file is required" }); return; }
    if (!(file.mimetype || "").startsWith("image/")) { res.status(400).json({ error: "invalid_file", message: "Only image files are allowed" }); return; }

    const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";
    if (disableS3) { res.status(503).json({ error: "s3_disabled", message: "S3 is disabled (DISABLE_S3=true). Avatar upload is unavailable." }); return; }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "s3_not_configured", message: "S3_BUCKET not configured" }); return; }
    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    const fileId = uuidv4();
    const inputMime = (file.mimetype || "").toLowerCase();
    const isAnimated = inputMime === "image/gif" || inputMime === "image/webp" || inputMime === "image/avif";
    const key = `avatars/${fileId}.avif`;

    Promise.resolve()
      .then(async () => {
        // Enforce server-configured avatar max size (best-effort; falls back to multer limit).
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.avatar_max_bytes === "number" ? cfg.avatar_max_bytes : DEFAULT_AVATAR_MAX_BYTES);
        if (typeof maxBytes === "number" && maxBytes > 0 && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `Avatar too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        let storedBody: Buffer;
        const storedMime = "image/avif";
        let storedSize: number;
        let width: number | null = null;
        let height: number | null = null;

        let thumbKey: string | null = null;
        let thumb: Buffer | null = null;

        try {
          const meta = await sharp(file.buffer, { animated: isAnimated }).metadata().catch(() => null);
          if (meta?.width && meta?.height) { width = meta.width; height = meta.height; }
          storedBody = await sharp(file.buffer, { animated: isAnimated })
            .resize({ width: 256, height: 256, fit: "cover" })
            .avif()
            .toBuffer();
          storedSize = storedBody.length;
          thumb = await sharp(file.buffer, { animated: isAnimated })
            .resize({ width: 64, height: 64, fit: "cover" })
            .avif({ quality: 50 })
            .toBuffer();
        } catch {
          res.status(400).json({ error: "invalid_file", message: "Could not process image. Please upload a valid image under the size limit." });
          return;
        }

        // Upload main object
        try {
          await putObject({ bucket, key, body: storedBody, contentType: storedMime });
        } catch (e) {
          const msg = (e instanceof Error && e.message.trim().length > 0) ? e.message : "S3 upload failed.";
          console.error("avatar_upload_s3_error", { bucket, key, message: msg });
          res.status(502).json({ error: "s3_error", message: msg });
          return;
        }

        // Upload thumbnail (best-effort; don't fail the avatar on thumb issues)
        if (thumb) {
          thumbKey = `avatars/thumb_${fileId}.avif`;
          try {
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/avif" });
          } catch (e) {
            const msg = (e instanceof Error && e.message.trim().length > 0) ? e.message : "S3 upload failed.";
            console.error("avatar_thumb_s3_error", { bucket, key: thumbKey, message: msg });
            thumbKey = null;
          }
        }

        await insertFile({
          file_id: fileId,
          s3_key: key,
          mime: storedMime,
          size: storedSize,
          width,
          height,
          thumbnail_key: thumbKey,
          original_name: file.originalname || null,
          created_at: new Date(),
        });

        await updateUserAvatar(serverUserId, fileId);
        res.status(201).json({ avatarFileId: fileId });
      })
      .catch(next);
  },
);

uploadsRouter.delete(
  "/avatar",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    Promise.resolve()
      .then(async () => {
        // Clear avatar reference (we intentionally do not delete old files from S3).
        // Passing null clears `avatar_file_id` in both user tables.
        await setUserAvatar(serverUserId, null);
        res.status(200).json({ ok: true });
      })
      .catch(next);
  }
);

uploadsRouter.get(
  "/files/:fileId",
  (req: Request, res: Response, next: NextFunction): void => {
    const { fileId } = req.params;
    if (!fileId) { res.status(400).json({ error: "fileId is required" }); return; }

    const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";
    if (disableS3) { res.status(503).json({ error: "s3_disabled", message: "S3 is disabled (DISABLE_S3=true)." }); return; }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "S3_BUCKET not configured" }); return; }

    Promise.resolve()
      .then(async () => {
        const fileMeta = await getFile(fileId);
        if (!fileMeta) { res.status(404).json({ error: "File not found" }); return; }

        const useThumb = req.query.thumb === "1" && fileMeta.thumbnail_key;
        const s3Key = useThumb ? fileMeta.thumbnail_key! : fileMeta.s3_key;
        const totalSize = useThumb ? null : (fileMeta.size ?? null);

        const rangeHeader = req.headers.range;

        // IMPORTANT: do not redirect to S3/MinIO endpoints. In dev those are often localhost,
        // and browsers cannot reach the server's localhost. Stream through the API instead.
        const obj = await getObject({ bucket, key: s3Key, range: rangeHeader || undefined });
        const body = obj.Body;
        if (!body) {
          res.status(502).json({ error: "s3_error", message: "Empty S3 response body" });
          return;
        }

        const contentType = useThumb
          ? (fileMeta.thumbnail_key?.endsWith(".avif") ? "image/avif" : "image/jpeg")
          : (fileMeta.mime || undefined);
        if (contentType) res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=60");
        res.setHeader("Accept-Ranges", "bytes");

        if (req.query.download === "1") {
          const fileName = fileMeta.original_name || `${fileId}.${mime.extension(fileMeta.mime || "") || "bin"}`;
          res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, '\\"')}"`);
        }

        const isPartial = obj.ContentRange || obj.$metadata?.httpStatusCode === 206;
        if (isPartial && obj.ContentRange) {
          res.status(206);
          res.setHeader("Content-Range", obj.ContentRange);
        } else if (totalSize != null) {
          res.setHeader("Content-Length", String(totalSize));
        }

        if (obj.ContentLength != null) {
          res.setHeader("Content-Length", String(obj.ContentLength));
        }

        if (body instanceof Readable) {
          body.pipe(res);
          return;
        }

        const bytes = await body.transformToByteArray();
        res.end(Buffer.from(bytes));
      })
      .catch(next);
  },
);
