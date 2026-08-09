import consola from "consola";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { imageSize } from "image-size";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import mime from "mime-types";
import sharp from "sharp";
import { execFile } from "child_process";
import { unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { deleteObject, putObject, getObject } from "../storage";
import { insertFile, insertImageJob, getFile, updateFileRecord, updateUserAvatar, setUserAvatar, getServerConfig, DEFAULT_AVATAR_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES } from "../db";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { AVATAR_MAX_PX, AVATAR_THUMB_PX } from "../constants/media";
import { findDominantColor, validateImage } from "../utils/imageValidation";
import { sanitizeSvg } from "../utils/svgSanitize";

/**
 * Takes the path multer already wrote, rather than a buffer.
 *
 * It used to write the buffer back out to a temp file so ffmpeg had something
 * to open. With the upload on disk from the start that round trip is gone, and
 * with it the only reason a video had to fit in memory.
 */
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

/**
 * Types a browser may render straight from this endpoint.
 *
 * Everything else is sent as a download. The list is raster images, video and
 * audio — formats a browser decodes as media and cannot execute.
 *
 * SVG is on the list now, and it is the one entry that needs justifying, since
 * an SVG is a document rather than a picture. Three things have to hold, and do:
 *
 *   1. Everything stored as image/svg+xml has been through sanitizeSvg() —
 *      script, event handlers, foreignObject and external references are gone
 *      before it is written. An SVG that predates that, or arrives another way,
 *      is not covered by this reasoning.
 *   2. The client only ever draws these through <img>, where a browser does not
 *      run script or fetch subresources. There is no dangerouslySetInnerHTML in
 *      the client, so none of them is inlined into the DOM.
 *   3. Opened directly as a document, the CSP two lines below applies: a sandbox
 *      with no tokens blocks scripts. That header is what makes this safe rather
 *      than merely usually-safe, so it is not optional.
 *
 * Serving it as a download instead would be safer still and would also stop
 * avatars rendering, since an attachment cannot be an <img> source.
 */
function isInlineSafe(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/")
  );
}

// Avatars and emoji stay in memory. Both are re-encoded through sharp
// immediately and both carry their own small ceilings, so a temp file would be
// written and deleted for no benefit.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

/**
 * An image has to be decoded to be validated, and decoding means holding it.
 * Generic files and videos have no such requirement and are not subject to
 * this — it is a validation ceiling, not an upload one. 64 MB is far past any
 * real photograph and far below anything that threatens the process.
 */
const IMAGE_VALIDATION_MAX_BYTES = 64 * 1024 * 1024;

/**
 * multer for the general upload route, writing to disk and enforcing the
 * server's own configured limit.
 *
 * There used to be two independent ceilings — a fixed 200 MB here and whatever
 * the server was configured for — and the lower one silently won. An operator
 * who set 500 MB got 200, with nothing saying so. Now there is one number, it
 * is the operator's, and multer refuses the request as it streams rather than
 * after a large file has already landed on disk.
 *
 * Zero means unlimited, which is what makes the unlimited branch in the
 * enforcement code below reachable for the first time.
 */
function uploadToDisk(field: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
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

/**
 * Deletes the temp file multer wrote, on every exit path including the ones
 * that threw. Without this an upload that fails validation leaves its bytes on
 * the host's disk, which is the failure mode that turns a disk-backed upload
 * route into a disk-filling one.
 */
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
    const fileMime = (file.mimetype || "").toLowerCase();
    const isImage = fileMime.startsWith("image/");
    const isVideo = fileMime.startsWith("video/");

    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES);
        const hasLimit = typeof maxBytes === "number" && maxBytes > 0;

        // Applies to everything, images included.
        //
        // Images used to be exempt, on the assumption that the image worker
        // would shrink them afterwards. That was never a size limit, for two
        // reasons: the worker only runs after the original has been written, so
        // the full-size file lands on the host's disk regardless; and a server
        // hosted from the desktop app had no worker at all until GRYT-68, so
        // nothing ever shrank anything. Whoever hosted for their friends had an
        // uncapped write channel into their own storage and no way to see it.
        //
        // The cost is that a photo above the limit is now refused rather than
        // accepted and quietly resized. That is the honest behaviour: the limit
        // is what the server says it is, and it says so before taking the file.
        //
        // Belt and braces. multer already refused anything over the limit as
        // it streamed, so reaching this with an oversized file means the
        // setting changed between the two reads. Cheap to keep, and it is the
        // only check if that ever stops being true.
        if (hasLimit && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `File too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        const key = `uploads/${fileId}.${mime.extension(file.mimetype || "") || "bin"}`;
        const storedMime: string = file.mimetype || "application/octet-stream";
        let thumbKey: string | null = null;
        let width: number | null = null;
        let height: number | null = null;

        // SVG is accepted here as the vector, sanitised, and deliberately never
        // queued as an image job below — the worker would hand it to sharp, and
        // sharp renders SVG through librsvg. Storing the vector is what keeps a
        // memory-unsafe parser away from a stranger's bytes.
        if (fileMime === "image/svg+xml") {
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
            original_name: file.originalname || null,
            created_at: new Date(),
          });

          res.status(201).json({ fileId, key: svgKey, thumbnailKey: null });
          return;
        }

        if (isImage) {
          // Anything claiming to be an image has to actually decode as one of
          // the raster formats we allow. This route previously took the mime
          // straight from the request and stored the bytes untouched, so an
          // SVG carrying <script> was kept verbatim and served back inline.
          //
          // Validating means decoding, and decoding means holding it, so this
          // is the one path that still reads the whole file. Refusing an
          // absurd "image" is better than handing it to sharp: a file this
          // size claiming to be a PNG is not a photograph.
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

          if (!width || !height) {
            try {
              const dims = imageSize(imageBytes);
              if (dims.width && dims.height) {
                width = dims.width;
                height = dims.height;
              }
            } catch {
              consola.debug("image-size fallback failed for", fileId);
            }
          }
        }

        // The whole point of the exercise: the bytes go from multer's temp file
        // to storage without the process ever holding them.
        await putObject({ bucket, key, sourcePath: file.path, contentType: storedMime });

        if (isVideo) {
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
          original_name: file.originalname || null,
          created_at: new Date(),
        });

        if (isImage) {
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
      // Every exit path, including the early returns for a bad SVG, an oversized
      // image, and anything that threw. multer's temp file is ours from the
      // moment it exists and nothing else will remove it.
      .finally(() => discardTemp(file))
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

        // Animated files used to be exempt here, and were accepted oversized on
        // the understanding that the resize below would bring them down. The
        // limit is the limit: a file over it is refused, whatever is in it.
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

        // SVG takes its own path and never reaches sharp. It is stored as the
        // vector it is — one small file that stays sharp at whatever size the
        // UI asks for, where a raster needs a set of them — and sanitised on
        // the way in. See svgSanitize.ts for why that is enough.
        if ((file.mimetype || "").toLowerCase() === "image/svg+xml") {
          const svg = sanitizeSvg(file.buffer);
          if (!svg.valid) {
            res.status(400).json({ error: "invalid_file", message: svg.reason });
            return;
          }

          const body = Buffer.from(svg.svg, "utf8");
          key = `avatars/${fileId}.svg`;
          await putObject({ bucket, key, body, contentType: "image/svg+xml" });

          // No thumbnail. A thumbnail exists to avoid sending a large raster
          // where a small one will do, and a vector is already the small one.
          // Consumers that ask for a thumb fall back to the file itself.
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

        // Dimensions, not bytes. Anything over the byte limit was refused above,
        // so what is left to catch here is the modestly-sized animated avatar
        // with large dimensions, which would otherwise be stored exactly as
        // uploaded and served at full size to every viewer (GRYT-66).
        //
        // The byte comparison stays as a guard rather than a decision: it is
        // redundant only for as long as the check above sits before this one.
        const withinBounds =
          file.size <= maxBytes &&
          (width ?? 0) <= AVATAR_MAX_PX &&
          (height ?? 0) <= AVATAR_MAX_PX;

        if (isAnimated && withinBounds) {
          key = `avatars/${fileId}.${animExt}`;
          storedBody = file.buffer;
          storedMime = inputMime;
          storedSize = file.size;

          const thumb = await sharp(file.buffer, { pages: 1, failOn: "error" })
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
            storedBody = await sharp(file.buffer, { pages: 1, failOn: "error" })
              .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" })
              .avif()
              .toBuffer();
          } catch {
            res.status(400).json({ error: "invalid_file", message: "Could not process image." });
            return;
          }
          storedMime = "image/avif";
          storedSize = storedBody.length;
          // What was stored, not what was uploaded. `cover` with both axes set
          // crops to exactly this box, and recording the original meant the row
          // described a file that no longer existed.
          width = AVATAR_MAX_PX;
          height = AVATAR_MAX_PX;
        } else {
          key = `avatars/${fileId}.avif`;
          try {
            storedBody = await sharp(file.buffer, { failOn: "error" })
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

          const thumb = await sharp(file.buffer, { failOn: "error" })
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

        // Taken from the original upload rather than from `storedBody`, which
        // for an oversized animated avatar is a single-frame placeholder that
        // gets replaced further down. The source image is the same either way.
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
                const pipeline = sharp(animBuf, { animated: true, failOn: "error" })
                  .resize({ width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, fit: "cover" });
                const resized = outputFormat === "gif"
                  ? await pipeline.gif().toBuffer()
                  : await pipeline.webp().toBuffer();

                const animKey = `avatars/${fileId}.${outputFormat}`;
                await putObject({ bucket, key: animKey, body: resized, contentType: outputMime });

                const thumbBuf = await sharp(resized, { pages: 1, failOn: "error" })
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
    const fileId = String(req.params.fileId);
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

        // Defence in depth, on the assumption that something unwanted got past
        // the upload checks anyway. nosniff stops a mislabelled file being
        // re-interpreted as something executable; the CSP neuters scripts and
        // subresources if it is rendered as a document regardless; and anything
        // outside the inline allowlist is handed over as a download rather than
        // rendered. Uploads are served from the API's own origin, so a document
        // that runs here runs with the session.
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
