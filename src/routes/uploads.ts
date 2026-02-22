import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import mime from "mime-types";
import sharp from "sharp";
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
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

// Absolute cap; server-configured limits apply per request.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

export const uploadsRouter = express.Router();

uploadsRouter.post(
  "/",
  requireBearerToken as any,
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
    const ext = mime.extension(file.mimetype || "") || "bin";
    const key = `uploads/${fileId}.${ext}`;

    const isImage = (file.mimetype || "").startsWith("image/");

    Promise.resolve()
      .then(async () => {
        // Enforce server-configured upload max size (best-effort; falls back to multer limit).
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES);
        if (typeof maxBytes === "number" && maxBytes > 0 && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `File too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        await putObject({ bucket, key, body: file.buffer, contentType: file.mimetype || undefined });
        let thumbKey: string | null = null;
        let width: number | null = null;
        let height: number | null = null;
        const isVideo = (file.mimetype || "").startsWith("video/");
        if (isImage) {
          const image = sharp(file.buffer);
          const metadata = await image.metadata();
          if (metadata.width && metadata.height) {
            width = metadata.width;
            height = metadata.height;
          }
          const thumb = await image.resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
          thumbKey = `thumbnails/${fileId}.jpg`;
          await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/jpeg" });
        } else if (isVideo) {
          const thumb = await extractVideoThumbnail(file.buffer, fileId);
          if (thumb) {
            thumbKey = `thumbnails/${fileId}.jpg`;
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/jpeg" }).catch(() => { thumbKey = null; });
          }
        }
        await insertFile({
          file_id: fileId,
          s3_key: key,
          mime: file.mimetype || null,
          size: file.size ?? null,
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
  requireBearerToken as any,
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
    const isGif = (file.mimetype || "").toLowerCase() === "image/gif";
    const ext = isGif ? "gif" : (mime.extension(file.mimetype || "") || "png");
    const key = `avatars/${fileId}.${ext}`;

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
        let storedMime: string;
        let storedSize: number;
        let width: number | null = null;
        let height: number | null = null;

        // Always attempt to compute a thumbnail (first frame for GIFs).
        let thumbKey: string | null = null;
        let thumb: Buffer | null = null;

        // For GIFs: resize while preserving animation. Thumbnail generation is best-effort.
        if (isGif) {
          try {
            const meta = await sharp(file.buffer, { animated: true }).metadata().catch(() => null);
            if (meta?.width && meta?.height) { width = meta.width; height = meta.height; }
            storedBody = await sharp(file.buffer, { animated: true })
              .resize({ width: 256, height: 256, fit: "cover" })
              .gif()
              .toBuffer();
            storedMime = "image/gif";
            storedSize = storedBody.length;
            thumb = await sharp(file.buffer, { animated: true })
              .resize({ width: 64, height: 64, fit: "cover" })
              .jpeg({ quality: 70 })
              .toBuffer();
          } catch {
            storedBody = file.buffer;
            storedMime = "image/gif";
            storedSize = file.size;
            thumb = null;
          }
        } else {
          try {
            const image = sharp(file.buffer);
            const meta = await image.metadata().catch(() => null);
            if (meta?.width && meta?.height) { width = meta.width; height = meta.height; }

            storedBody = await image
              .resize({ width: 256, height: 256, fit: "cover" })
              .png({ quality: 85 })
              .toBuffer();
            storedMime = "image/png";
            storedSize = storedBody.length;

            thumb = await sharp(file.buffer)
              .resize({ width: 64, height: 64, fit: "cover" })
              .jpeg({ quality: 70 })
              .toBuffer();
          } catch {
            res.status(400).json({ error: "invalid_file", message: "Could not process image. Please upload a valid image under the size limit." });
            return;
          }
        }

        // Upload main object
        try {
          await putObject({ bucket, key, body: storedBody, contentType: storedMime });
        } catch (e: any) {
          const msg = (typeof e?.message === "string" && e.message.trim().length > 0) ? e.message : "S3 upload failed.";
          console.error("avatar_upload_s3_error", { bucket, key, message: msg });
          res.status(502).json({ error: "s3_error", message: msg });
          return;
        }

        // Upload thumbnail (best-effort; don't fail the avatar on thumb issues)
        if (thumb) {
          thumbKey = `avatars/thumb_${fileId}.jpg`;
          try {
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/jpeg" });
          } catch (e: any) {
            const msg = (typeof e?.message === "string" && e.message.trim().length > 0) ? e.message : "S3 upload failed.";
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
  requireBearerToken as any,
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
        const body: any = (obj as any)?.Body;
        if (!body) {
          res.status(502).json({ error: "s3_error", message: "Empty S3 response body" });
          return;
        }

        const contentType = useThumb ? "image/jpeg" : (fileMeta.mime || undefined);
        if (contentType) res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=60");
        res.setHeader("Accept-Ranges", "bytes");

        if (req.query.download === "1") {
          const fileName = fileMeta.original_name || `${fileId}.${mime.extension(fileMeta.mime || "") || "bin"}`;
          res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, '\\"')}"`);
        }

        const isPartial = (obj as any).ContentRange || (obj as any).$metadata?.httpStatusCode === 206;
        if (isPartial && (obj as any).ContentRange) {
          res.status(206);
          res.setHeader("Content-Range", (obj as any).ContentRange);
        } else if (totalSize != null) {
          res.setHeader("Content-Length", String(totalSize));
        }

        if ((obj as any).ContentLength != null) {
          res.setHeader("Content-Length", String((obj as any).ContentLength));
        }

        if (typeof body.pipe === "function") {
          body.pipe(res);
          return;
        }

        if (typeof body.transformToByteArray === "function") {
          const bytes = await body.transformToByteArray();
          res.end(Buffer.from(bytes));
          return;
        }

        if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
          res.end(Buffer.from(body));
          return;
        }

        res.status(502).json({ error: "s3_error", message: "Unsupported S3 body type" });
      })
      .catch(next);
  },
);
