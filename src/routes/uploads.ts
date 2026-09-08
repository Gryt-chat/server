import consola from "consola";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import mime from "mime-types";
import sharp from "sharp";
import { execFile } from "child_process";
import { unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { deleteObject, putObject, getObject } from "../storage";
import { insertFile, insertImageJob, getFile, updateFileRecord, updateUserAvatar, setUserAvatar, getServerConfig, getUserByServerId, DEFAULT_AVATAR_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES } from "../db";
import { isSealedUpload, storageForUpload } from "./uploadStorage";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { verifyFileToken } from "../utils/jwt";
import { ensurePermission } from "../middleware/requirePermission";
import { AVATAR_MAX_PX, AVATAR_THUMB_PX } from "../constants/media";
import { findDominantColor, validateImage, MAX_INPUT_PIXELS } from "../utils/imageValidation";
import { sanitizeSvg } from "../utils/svgSanitize";

/** Takes multer's path, so a video never has to fit in memory. */
async function extractVideoThumbnail(inputPath: string, fileId: string): Promise<Buffer | null> {
  const outputPath = join(tmpdir(), `gryt-thumb-${fileId}.jpg`);
  try {
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
    // Only the output. The input belongs to the caller, which cleans it up.
    await unlink(outputPath).catch((e) => consola.warn("temp file cleanup failed", e));
  }
}

/** SVG is on this list only because it has been through sanitizeSvg(), is drawn
    through `<img>`, and is sandboxed by the CSP below. That header is required. */
function isInlineSafe(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/")
  );
}

// Avatars and emoji stay in memory: both are re-encoded through sharp at once
// and carry their own ceilings, so a temp file would be written and deleted.

/** A validation ceiling, not an upload one: decoding an image means holding it.
    Files and videos are not subject to this. */
const IMAGE_VALIDATION_MAX_BYTES = 64 * 1024 * 1024;

/** One ceiling, the operator's, refused as it streams rather than after the
    file has landed. Zero means unlimited. */
function uploadToDisk(field: string) {
  return function bufferUploadToDisk(req: Request, res: Response, next: NextFunction): void {
    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES;
        const limits = typeof maxBytes === "number" && maxBytes > 0 ? { fileSize: maxBytes } : undefined;
        multer({ storage: multer.diskStorage({}), limits }).single(field)(req, res, next);
      })
      .catch(next);
  };
}

/** Refuses an oversized avatar before it is in memory: this path re-encodes
    rather than streaming, so a later check governs storage, not allocation. */
function uploadAvatarToMemory(field: string) {
  return function bufferAvatarToMemory(req: Request, res: Response, next: NextFunction): void {
    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = typeof cfg?.avatar_max_bytes === "number" ? cfg.avatar_max_bytes : DEFAULT_AVATAR_MAX_BYTES;
        const limits = typeof maxBytes === "number" && maxBytes > 0 ? { fileSize: maxBytes } : undefined;
        multer({ storage: multer.memoryStorage(), limits }).single(field)(req, res, next);
      })
      .catch(next);
  };
}

/** Every exit path, including the ones that threw: otherwise a failed
    validation leaves its bytes on the host's disk. */
async function discardTemp(file: Express.Multer.File | undefined): Promise<void> {
  if (!file?.path) return;
  await unlink(file.path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") consola.warn("upload temp cleanup failed", file.path, e);
  });
}

export const uploadsRouter = express.Router();

function parseDimField(val: unknown): number | null {
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

uploadsRouter.post(
  "/",
  requireBearerToken,
  // Before multer, not after: refusing a hundred megabytes once it has already
  // been written to disk is a refusal that still cost the disk write.
  (req: Request, res: Response, next: NextFunction): void => {
    ensurePermission(req, res, "attach_files")
      .then((ok) => { if (ok) next(); })
      .catch(next);
  },
  uploadToDisk("file"),
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

    // In its own file because nothing in here loads in a test, and because
    // sealing is the part with a security answer. See `uploadStorage.ts`.
    const storage = storageForUpload({
      sealed: isSealedUpload(req.body),
      fileId,
      mimetype: file.mimetype,
      originalName: file.originalname,
    });

    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES);
        const hasLimit = typeof maxBytes === "number" && maxBytes > 0;

        // Images too: the worker runs after the original is written, and a
        // desktop-hosted server has none. Multer already refused as it streamed.
        if (hasLimit && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `File too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        const { key, storedMime } = storage;
        let thumbKey: string | null = null;
        let width: number | null = null;
        let height: number | null = null;

        // Stored as the sanitised vector and never queued as an image job: the
        // worker would hand it to sharp, which renders SVG through librsvg.
        if (storage.treatAsSvg) {
          const svg = sanitizeSvg(await readFile(file.path));
          if (!svg.valid) {
            res.status(400).json({ error: "invalid_file", message: svg.reason });
            return;
          }

          const body = Buffer.from(svg.svg, "utf8");
          const svgKey = `uploads/${fileId}.svg`;
          await putObject({ bucket, key: svgKey, body, contentType: "image/svg+xml" });

          await insertFile({
            file_id: fileId,
            s3_key: svgKey,
            mime: "image/svg+xml",
            size: body.length,
            width: svg.width,
            height: svg.height,
            thumbnail_key: null,
            // Through the decision rather than off the request, so there is
            // one place the client's filename can reach a row.
            original_name: storage.originalName,
            created_at: new Date(),
          });

          res.status(201).json({ fileId, key: svgKey, thumbnailKey: null });
          return;
        }

        if (storage.validateAsImage) {
          // The mime off the request is a claim, and taking it meant an SVG
          // carrying <script> was served back inline.
          if (file.size > IMAGE_VALIDATION_MAX_BYTES) {
            res.status(413).json({
              error: "file_too_large",
              message: `Images are capped at ${(IMAGE_VALIDATION_MAX_BYTES / (1024 * 1024)).toFixed(0)}MB so they can be checked before they are stored.`,
            });
            return;
          }

          const imageBytes = await readFile(file.path);
          const validation = await validateImage(imageBytes, { animated: true });
          if (!validation.valid) {
            res.status(400).json({ error: "invalid_file", message: validation.reason });
            return;
          }

          width = parseDimField(req.body?.width);
          height = parseDimField(req.body?.height);

          // `validateImage` already read the dimensions off the same decode.
          // The second library was `image-size`, whose advisory has no fix.
          if (!width || !height) {
            width = validation.width;
            height = validation.height;
          }
        }

        // The whole point of the exercise: the bytes go from multer's temp file
        // to storage without the process ever holding them.
        await putObject({ bucket, key, sourcePath: file.path, contentType: storedMime });

        if (storage.extractVideoThumbnail) {
          const thumb = await extractVideoThumbnail(file.path, fileId);
          if (thumb) {
            thumbKey = `thumbnails/${fileId}.jpg`;
            await putObject({ bucket, key: thumbKey, body: thumb, contentType: "image/jpeg" }).catch(() => { thumbKey = null; });
          }
        }

        await insertFile({
          file_id: fileId,
          s3_key: key,
          mime: storedMime,
          size: file.size,
          width,
          height,
          thumbnail_key: thumbKey,
          original_name: storage.originalName,
          created_at: new Date(),
        });

        if (storage.queueImageJob) {
          const jobId = uuidv4();
          await insertImageJob({
            job_id: jobId,
            file_id: fileId,
            raw_s3_key: key,
            raw_content_type: storedMime,
            raw_bytes: file.size,
          }).catch((e: unknown) => consola.warn("Failed to queue image job", e));
        }

        res.status(201).json({ fileId, key, thumbnailKey: thumbKey });
      })
      // Every exit path, including the early returns and anything that threw:
      // multer's temp file is ours and nothing else removes it.
      .finally(() => discardTemp(file))
      .catch(next);
  },
);

uploadsRouter.post(
  "/avatar",
  requireBearerToken,
  /* `upload_avatar_image`, not `change_avatar`: this endpoint only ever gets a
     picture, so there is no flag for a modified client to lie about. */
  (req: Request, res: Response, next: NextFunction): void => {
    ensurePermission(req, res, "upload_avatar_image")
      .then((ok) => { if (ok) next(); })
      .catch(next);
  },
  uploadAvatarToMemory("file"),
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

        // No exemption for animated files: a file over the limit is refused
        // whatever is in it.
        if (typeof maxBytes === "number" && maxBytes > 0 && file.size > maxBytes) {
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

        // SVG never reaches sharp. Stored as the sanitised vector; see
        // svgSanitize.ts for why that is enough.
        if ((file.mimetype || "").toLowerCase() === "image/svg+xml") {
          const svg = sanitizeSvg(file.buffer);
          if (!svg.valid) {
            res.status(400).json({ error: "invalid_file", message: svg.reason });
            return;
          }

          const body = Buffer.from(svg.svg, "utf8");
          key = `avatars/${fileId}.svg`;
          await putObject({ bucket, key, body, contentType: "image/svg+xml" });

          // No thumbnail: a vector is already the small one, and anything
          // asking for a thumb falls back to the file.
          await insertFile({
            file_id: fileId,
            s3_key: key,
            mime: "image/svg+xml",
            size: body.length,
            width: svg.width,
            height: svg.height,
            thumbnail_key: null,
            original_name: file.originalname || null,
          });

          await setUserAvatar(serverUserId, fileId);
          res.json({ fileId, processing: false });
          return;
        }

        const validation = await validateImage(file.buffer, { animated: isAnimated });
        if (!validation.valid) {
          res.status(400).json({ error: "invalid_file", message: validation.reason });
          return;
        }
        width = validation.width;
        height = validation.height;

        // Dimensions, not bytes: what is left is the modestly-sized animated
        // avatar with large dimensions.
        const withinBounds =
          file.size <= maxBytes &&
          (width ?? 0) <= AVATAR_MAX_PX &&
          (height ?? 0) <= AVATAR_MAX_PX;

        if (isAnimated && withinBounds) {
          key = `avatars/${fileId}.${animExt}`;
          storedBody = file.buffer;
          storedMime = inputMime;
          storedSize = file.size;

          const thumb = await sharp(file.buffer, { pages: 1, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
            .resize({ width: AVATAR_THUMB_PX, height: AVATAR_THUMB_PX, fit: "cover" })
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
            storedBody = await sharp(file.buffer, { pages: 1, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
              .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" })
              .avif()
              .toBuffer();
          } catch {
            res.status(400).json({ error: "invalid_file", message: "Could not process image." });
            return;
          }
          storedMime = "image/avif";
          storedSize = storedBody.length;
          // What was stored, not what was uploaded: `cover` crops to exactly
          // this box, so the original describes a file that is gone.
          width = AVATAR_MAX_PX;
          height = AVATAR_MAX_PX;
        } else {
          key = `avatars/${fileId}.avif`;
          try {
            storedBody = await sharp(file.buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
              .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" })
              .avif()
              .toBuffer();
          } catch {
            res.status(400).json({ error: "invalid_file", message: "Could not process image. Please upload a valid image under the size limit." });
            return;
          }
          storedMime = "image/avif";
          storedSize = storedBody.length;
          width = AVATAR_MAX_PX;
          height = AVATAR_MAX_PX;

          const thumb = await sharp(file.buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
            .resize({ width: AVATAR_THUMB_PX, height: AVATAR_THUMB_PX, fit: "cover" })
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

        // From the original upload, not `storedBody`, which for an oversized
        // animated avatar is a placeholder replaced further down.
        const dominantColor = await findDominantColor(file.buffer, { animated: isAnimated });

        await insertFile({
          file_id: fileId,
          s3_key: key,
          mime: storedMime,
          size: storedSize,
          width,
          height,
          thumbnail_key: thumbKey,
          thumbnail_px: thumbKey ? AVATAR_THUMB_PX : null,
          original_name: file.originalname || null,
          dominant_color: dominantColor,
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
                // Every frame is decoded here, unlike the single-page check
                // that let this buffer through, so the ceiling comes with it.
                const pipeline = sharp(animBuf, { animated: true, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
                  .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" });
                const resized = outputFormat === "gif"
                  ? await pipeline.gif().toBuffer()
                  : await pipeline.webp().toBuffer();

                const animKey = `avatars/${fileId}.${outputFormat}`;
                await putObject({ bucket, key: animKey, body: resized, contentType: outputMime });

                const thumbBuf = await sharp(resized, { pages: 1, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
                  .resize({ width: AVATAR_THUMB_PX, height: AVATAR_THUMB_PX, fit: "cover" })
                  .avif({ quality: 50 })
                  .toBuffer()
                  .catch(() => null);
                const newThumbKey = thumbBuf ? `avatars/thumb_${fileId}.avif` : null;
                if (thumbBuf && newThumbKey) {
                  await putObject({ bucket, key: newThumbKey, body: thumbBuf, contentType: "image/avif" }).catch(() => {});
                }

                await updateFileRecord(fileId, { s3_key: animKey, mime: outputMime, size: resized.length, thumbnail_key: newThumbKey, thumbnail_px: newThumbKey ? AVATAR_THUMB_PX : null });

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

    // Same permission as setting one, or the gate bites in one direction and
    // "reset to default" walks around it.
    Promise.resolve()
      .then(async () => {
        if (!(await ensurePermission(req, res, "change_avatar"))) return;

        // Clear avatar reference (we intentionally do not delete old files from S3).
        // Passing null clears `avatar_file_id` in both user tables.
        await setUserAvatar(serverUserId, null);
        res.status(200).json({ ok: true });
      })
      .catch(next);
  }
);

/** In the query string because these URLs end up in `<img src>`. No per-file
    check: a file token is only minted for a member, so holding one is the test. */
async function mayReadFiles(req: Request): Promise<boolean> {
  const raw = req.query.t;
  const token = typeof raw === "string" ? raw : null;
  if (!token) return false;

  const payload = verifyFileToken(token);
  if (!payload) return false;

  const host = req.headers.host || "unknown";
  if (payload.serverHost !== host) return false;

  try {
    const cfg = await getServerConfig();
    const currentVersion = cfg?.token_version ?? 0;
    if ((payload.tokenVersion ?? 0) !== currentVersion) return false;

    // A file token lives twelve hours against an access token's fifteen
    // minutes, so an ended session would keep reading uploads all day.
    const member = await getUserByServerId(payload.serverUserId);
    if (!member) return false;
    if ((payload.userTokenVersion ?? 0) !== (member.token_version ?? 0)) return false;
  } catch {
    // The config is unreadable, so the version cannot be checked. Refuse rather
    // than serve: this is the path that had no check at all until GRYT-740.
    return false;
  }

  return true;
}

uploadsRouter.get(
  "/files/:fileId",
  (req: Request, res: Response, next: NextFunction): void => {
    const fileId = String(req.params.fileId);
    if (!fileId) { res.status(400).json({ error: "fileId is required" }); return; }

    const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";
    if (disableS3) { res.status(503).json({ error: "s3_disabled", message: "S3 is disabled (DISABLE_S3=true)." }); return; }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "S3_BUCKET not configured" }); return; }

    Promise.resolve()
      .then(async () => {
        // Before the lookup, so an unauthenticated caller cannot use the 404 to
        // learn which file ids exist.
        if (!(await mayReadFiles(req))) {
          res.status(401).json({ error: "auth_required", message: "A file token is required to read uploads." });
          return;
        }

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
        // `private`, not `public`: the URL carries a credential, and a shared
        // cache would hand one person's token to whoever asked next.
        res.setHeader("Cache-Control", "private, max-age=60");
        res.setHeader("Accept-Ranges", "bytes");

        // Uploads are served from the API's own origin, so a document that runs
        // here runs with the session. These three assume the checks were passed.
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");

        if (req.query.download === "1" || !isInlineSafe(contentType)) {
          const fileName = fileMeta.original_name || `${fileId}.${mime.extension(fileMeta.mime || "") || "bin"}`;
          res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, '\\"')}"`);
        }

        if (obj.ContentRange) {
          res.status(206);
          res.setHeader("Content-Range", obj.ContentRange);
        } else if (totalSize != null) {
          res.setHeader("Content-Length", String(totalSize));
        }

        if (obj.ContentLength != null) {
          res.setHeader("Content-Length", String(obj.ContentLength));
        }

        body.pipe(res);
      })
      .catch(next);
  },
);
