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
import { deleteObject, putObject, getObject } from "../storage/s3";
import { insertFile, getFile, updateFileRecord, updateUserAvatar, setUserAvatar, getServerConfig, DEFAULT_AVATAR_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES } from "../db/scylla";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { validateImage } from "../utils/imageValidation";

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
    const isGif = fileMime === "image/gif";
    const isWebp = fileMime === "image/webp";
    const isAvif = fileMime === "image/avif";
    const isPotentiallyAnimatedImage = isGif || isWebp;

    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES);
        const hasLimit = typeof maxBytes === "number" && maxBytes > 0;

        if (!isImage && hasLimit && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `File too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        let key = `uploads/${fileId}.${mime.extension(file.mimetype || "") || "bin"}`;
        let storedBody: Buffer = file.buffer;
        let storedMime: string = file.mimetype || "application/octet-stream";
        let storedSize: number = file.size;
        let thumbKey: string | null = null;
        let width: number | null = null;
        let height: number | null = null;

        if (isImage) {
          const validation = await validateImage(file.buffer, { animated: isPotentiallyAnimatedImage });
          if (!validation.valid) {
            res.status(400).json({ error: "invalid_file", message: validation.reason });
            return;
          }
          width = validation.width;
          height = validation.height;

          const isAnimated = isPotentiallyAnimatedImage && typeof validation.pages === "number" && validation.pages > 1;
          const shouldStoreOriginal = isGif || isAvif || (isWebp && isAnimated);

          if (shouldStoreOriginal) {
            if (hasLimit && file.size > maxBytes) {
              res.status(413).json({
                error: "file_too_large",
                message: `File too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
              });
              return;
            }
          } else if (hasLimit && file.size > maxBytes) {
            let avifBuf: Buffer;
            try {
              avifBuf = await sharp(file.buffer, { failOn: "error" }).avif().toBuffer();
            } catch {
              res.status(400).json({ error: "invalid_file", message: "Could not process image." });
              return;
            }
            if (avifBuf.length > maxBytes) {
              res.status(413).json({
                error: "file_too_large",
                message: `File too large even after compression. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
              });
              return;
            }
            key = `uploads/${fileId}.avif`;
            storedBody = avifBuf;
            storedMime = "image/avif";
            storedSize = avifBuf.length;
          }

          const thumbPipeline = isPotentiallyAnimatedImage
            ? sharp(file.buffer, { pages: 1, failOn: "error" })
            : sharp(file.buffer, { failOn: "error" });
          const thumb = await thumbPipeline
            .resize({ width: 320, withoutEnlargement: true })
            .avif({ quality: 50 })
            .toBuffer()
            .catch(() => null);
          if (thumb) {
            thumbKey = `thumbnails/${fileId}.avif`;
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/avif" });
          }
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
    const isAnimated = inputMime === "image/gif" || inputMime === "image/webp";
    const animExt = inputMime === "image/gif" ? "gif" : "webp";

    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.avatar_max_bytes === "number" ? cfg.avatar_max_bytes : DEFAULT_AVATAR_MAX_BYTES);

        if (!isAnimated && typeof maxBytes === "number" && maxBytes > 0 && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `Avatar too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        let key: string;
        let storedBody: Buffer;
        let storedMime: string;
        let storedSize: number;
        let width: number | null = null;
        let height: number | null = null;
        let thumbKey: string | null = null;
        let processing = false;

        const validation = await validateImage(file.buffer, { animated: isAnimated });
        if (!validation.valid) {
          res.status(400).json({ error: "invalid_file", message: validation.reason });
          return;
        }
        width = validation.width;
        height = validation.height;

        if (isAnimated && file.size <= maxBytes) {
          key = `avatars/${fileId}.${animExt}`;
          storedBody = file.buffer;
          storedMime = inputMime;
          storedSize = file.size;

          const thumb = await sharp(file.buffer, { pages: 1, failOn: "error" })
            .resize({ width: 64, height: 64, fit: "cover" })
            .avif({ quality: 50 })
            .toBuffer()
            .catch(() => null);

          if (thumb) {
            thumbKey = `avatars/thumb_${fileId}.avif`;
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/avif" }).catch((e) => {
              console.error("avatar_thumb_s3_error", { bucket, key: thumbKey, message: (e instanceof Error ? e.message : "S3 upload failed.") });
              thumbKey = null;
            });
          }
        } else if (isAnimated) {
          key = `avatars/${fileId}.avif`;
          processing = true;
          try {
            storedBody = await sharp(file.buffer, { pages: 1, failOn: "error" })
              .resize({ width: 256, height: 256, fit: "cover" })
              .avif()
              .toBuffer();
          } catch {
            res.status(400).json({ error: "invalid_file", message: "Could not process image." });
            return;
          }
          storedMime = "image/avif";
          storedSize = storedBody.length;
        } else {
          key = `avatars/${fileId}.avif`;
          try {
            storedBody = await sharp(file.buffer, { failOn: "error" })
              .resize({ width: 256, height: 256, fit: "cover" })
              .avif()
              .toBuffer();
          } catch {
            res.status(400).json({ error: "invalid_file", message: "Could not process image. Please upload a valid image under the size limit." });
            return;
          }
          storedMime = "image/avif";
          storedSize = storedBody.length;

          const thumb = await sharp(file.buffer, { failOn: "error" })
            .resize({ width: 64, height: 64, fit: "cover" })
            .avif({ quality: 50 })
            .toBuffer()
            .catch(() => null);

          if (thumb) {
            thumbKey = `avatars/thumb_${fileId}.avif`;
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/avif" }).catch((e) => {
              console.error("avatar_thumb_s3_error", { bucket, key: thumbKey, message: (e instanceof Error ? e.message : "S3 upload failed.") });
              thumbKey = null;
            });
          }
        }

        try {
          await putObject({ bucket, key, body: storedBody, contentType: storedMime });
        } catch (e) {
          const raw = (e instanceof Error && e.message.trim().length > 0) ? e.message : "";
          console.error("avatar_upload_s3_error", { bucket, key, message: raw });
          const friendly =
            /InvalidBucketName|NoSuchBucket|bucket/i.test(raw)
              ? "File storage is misconfigured on this server. Please contact the server administrator."
              : /AccessDenied|Forbidden/i.test(raw)
                ? "File storage access denied. Please contact the server administrator."
                : raw.length > 0
                  ? `Avatar upload failed: ${raw}`
                  : "Avatar upload failed due to a storage error.";
          res.status(502).json({ error: "s3_error", message: friendly });
          return;
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
        res.status(201).json({ avatarFileId: fileId, processing });

        // Background: resize oversized animated file and replace the placeholder
        if (processing) {
          const animBuf = file.buffer;
          setImmediate(() => {
            (async () => {
              try {
                const outputFormat = inputMime === "image/gif" ? "gif" : "webp";
                const outputMime = `image/${outputFormat}`;
                const pipeline = sharp(animBuf, { animated: true, failOn: "error" })
                  .resize({ width: 256, height: 256, fit: "cover" });
                const resized = outputFormat === "gif"
                  ? await pipeline.gif().toBuffer()
                  : await pipeline.webp().toBuffer();

                const animKey = `avatars/${fileId}.${outputFormat}`;
                await putObject({ bucket, key: animKey, body: resized, contentType: outputMime });

                const thumbBuf = await sharp(resized, { pages: 1, failOn: "error" })
                  .resize({ width: 64, height: 64, fit: "cover" })
                  .avif({ quality: 50 })
                  .toBuffer()
                  .catch(() => null);
                const newThumbKey = thumbBuf ? `avatars/thumb_${fileId}.avif` : null;
                if (thumbBuf && newThumbKey) {
                  await putObject({ bucket, key: newThumbKey, body: thumbBuf, contentType: "image/avif" }).catch(() => {});
                }

                await updateFileRecord(fileId, { s3_key: animKey, mime: outputMime, size: resized.length, thumbnail_key: newThumbKey });

                if (animKey !== key) {
                  await deleteObject({ bucket, key }).catch(() => {});
                }

                consola.info(`Background avatar processing done for ${fileId} (${(resized.length / 1024).toFixed(0)}KB ${outputFormat})`);
              } catch (err) {
                consola.error(`Background avatar processing failed for ${fileId}`, err);
              }
            })();
          });
        }
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
          ? (mime.lookup(fileMeta.thumbnail_key || "") || "image/avif")
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
