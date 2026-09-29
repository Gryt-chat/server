import consola from "consola";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import mime from "mime-types";
import { unlink, readFile } from "fs/promises";
import { putObject, getObject } from "../storage";
import { insertFile, insertImageJob, getFile, updateUserAvatar, setUserAvatar, setUserBanner, getServerConfig, getUserByServerId, DEFAULT_AVATAR_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES } from "../db";
import { BANNER_BOX } from "../constants/media";
import { deleteUnreferencedFiles } from "../jobs/mediaSweep";
import { isSealedUpload, storageForUpload } from "./uploadStorage";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { verifyFileToken } from "../utils/jwt";
import { checkSignedFileUrl, readSignedFileUrl, type SignedFileUrl } from "../utils/fileUrl";
import { storeAvatarPicture } from "../services/avatarImage";
import { fileReadVerdict } from "../services/fileAccess";
import { RangeNotSatisfiableError } from "../utils/byteRange";
import { sendStoredBody } from "../utils/sendStoredBody";
import { ensurePermission } from "../middleware/requirePermission";
import { validateImage } from "../utils/imageValidation";
import { sanitizeSvg } from "../utils/svgSanitize";
import { PARSE_LIMITS, readVideoDimensionsFromFile } from "../utils/videoDimensions";

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
            uploaded_by_server_user_id: req.tokenPayload?.serverUserId ?? null,
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

        // Headers only, never a decode. The client's claim is the fallback, as it
        // is for images, and only counts when it gives both sides.
        if (storage.measureAsVideo) {
          const claimed = { width: parseDimField(req.body?.width), height: parseDimField(req.body?.height) };
          const measured = (await readVideoDimensionsFromFile(file.path)) ?? claimed;
          const fits = (n: number | null) => n !== null && n <= PARSE_LIMITS.maxSide;
          if (fits(measured.width) && fits(measured.height)) {
            width = measured.width;
            height = measured.height;
          }
        }

        await insertFile({
          file_id: fileId,
          s3_key: key,
          mime: storedMime,
          size: file.size,
          width,
          height,
          // A video's poster, like an image's thumbnail, is the worker's to fill in.
          thumbnail_key: null,
          original_name: storage.originalName,
          uploaded_by_server_user_id: req.tokenPayload?.serverUserId ?? null,
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

        res.status(201).json({ fileId, key, thumbnailKey: null });
      })
      // Every exit path, including the early returns and anything that threw:
      // multer's temp file is ours and nothing else removes it.
      .finally(() => discardTemp(file))
      .catch(next);
  },
);

/** One pipeline for every picture. Only an avatar or a banner is put on the
    uploader's own row; a group picture doing that was GRYT-1182. */
const storeAvatarImage = (purpose: "avatar" | "group" | "webhook" | "banner") =>
  (req: Request, res: Response, next: NextFunction): void => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: "file_required", message: "file is required" }); return; }
    if (!(file.mimetype || "").startsWith("image/")) { res.status(400).json({ error: "invalid_file", message: "Only image files are allowed" }); return; }

    const what = { avatar: "Avatar", group: "Group picture", webhook: "Webhook avatar", banner: "Banner" }[purpose];
    const disableS3 = (process.env.DISABLE_S3 || "").toLowerCase() === "true";
    if (disableS3) { res.status(503).json({ error: "s3_disabled", message: `S3 is disabled (DISABLE_S3=true). ${what} upload is unavailable.` }); return; }

    const bucket = process.env.S3_BUCKET as string;
    if (!bucket) { res.status(500).json({ error: "s3_not_configured", message: "S3_BUCKET not configured" }); return; }
    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }

    Promise.resolve()
      .then(async () => {
        const cfg = await getServerConfig().catch(() => null);
        const maxBytes = (typeof cfg?.avatar_max_bytes === "number" ? cfg.avatar_max_bytes : DEFAULT_AVATAR_MAX_BYTES);

        // No exemption for animated files: a file over the limit is refused
        // whatever is in it.
        if (typeof maxBytes === "number" && maxBytes > 0 && file.size > maxBytes) {
          res.status(413).json({
            error: "file_too_large",
            message: `${what} too large. Max ${(maxBytes / (1024 * 1024)).toFixed(1)}MB.`,
          });
          return;
        }

        // SVG never reaches sharp. Stored as the sanitised vector; see
        // svgSanitize.ts for why that is enough.
        if ((file.mimetype || "").toLowerCase() === "image/svg+xml") {
          // A vector is not cut to the 5:2 box, so a banner is always a raster.
          if (purpose === "banner") {
            res.status(400).json({ error: "invalid_file", message: "A banner can't be an SVG." });
            return;
          }
          const svg = sanitizeSvg(file.buffer);
          if (!svg.valid) {
            res.status(400).json({ error: "invalid_file", message: svg.reason });
            return;
          }

          const fileId = uuidv4();
          const body = Buffer.from(svg.svg, "utf8");
          const key = `avatars/${fileId}.svg`;
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
            uploaded_by_server_user_id: serverUserId,
          });

          if (purpose === "avatar") await setUserAvatar(serverUserId, fileId);
          res.json({ fileId, processing: false });
          return;
        }

        const stored = await storeAvatarPicture({
          bucket,
          bytes: file.buffer,
          mime: file.mimetype || "",
          originalName: file.originalname || null,
          uploadedBy: serverUserId,
          maxBytes,
          what,
          ...(purpose === "banner" ? { box: BANNER_BOX, prefix: "banners" } : {}),
        });
        if (!stored.ok) {
          res.status(stored.status).json({ error: stored.error, message: stored.message });
          return;
        }

        if (purpose === "avatar") {
          await updateUserAvatar(serverUserId, stored.fileId);
          res.status(201).json({ avatarFileId: stored.fileId, processing: stored.processing });
        } else if (purpose === "banner") {
          const previous = (await getUserByServerId(serverUserId))?.banner_file_id ?? null;
          await setUserBanner(serverUserId, stored.fileId);
          if (previous && previous !== stored.fileId) await deleteUnreferencedFiles([previous]);
          res.status(201).json({ bannerFileId: stored.fileId, processing: stored.processing });
        } else {
          res.status(201).json({ fileId: stored.fileId, processing: stored.processing });
        }
      })
      .catch(next);
  };

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
  storeAvatarImage("avatar"),
);

/* The same trusted-only gate as an uploaded avatar: a banner is a stranger's
   picture in front of everybody, and the file lives on this server. */
uploadsRouter.post(
  "/banner",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    ensurePermission(req, res, "upload_avatar_image")
      .then((ok) => { if (ok) next(); })
      .catch(next);
  },
  uploadAvatarToMemory("file"),
  storeAvatarImage("banner"),
);

// Ungated, unlike DELETE /avatar: losing the upload permission must not strand a banner.
uploadsRouter.delete(
  "/banner",
  requireBearerToken,
  (req: Request, res: Response, next: NextFunction): void => {
    const serverUserId = req.tokenPayload?.serverUserId;
    if (!serverUserId) { res.status(401).json({ error: "auth_required" }); return; }
    Promise.resolve()
      .then(async () => {
        const previous = (await getUserByServerId(serverUserId))?.banner_file_id ?? null;
        await setUserBanner(serverUserId, null);
        if (previous) await deleteUnreferencedFiles([previous]);
        res.status(200).json({ ok: true });
      })
      .catch(next);
  },
);

uploadsRouter.post(
  "/group-icon",
  requireBearerToken,
  // The permission the group handlers ask for, since only they use this file.
  (req: Request, res: Response, next: NextFunction): void => {
    ensurePermission(req, res, "send_direct_messages")
      .then((ok) => { if (ok) next(); })
      .catch(next);
  },
  uploadAvatarToMemory("file"),
  storeAvatarImage("group"),
);

uploadsRouter.post(
  "/webhook-avatar",
  requireBearerToken,
  // The permission every webhook route asks for, since only they use this file.
  (req: Request, res: Response, next: NextFunction): void => {
    ensurePermission(req, res, "manage_webhooks")
      .then((ok) => { if (ok) next(); })
      .catch(next);
  },
  uploadAvatarToMemory("file"),
  storeAvatarImage("webhook"),
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

interface FileReader { serverUserId: string; grytUserId: string }

/** Says who is asking, from a signed URL or the old `?t=` file token. Whether they
    may read this file is `fileReadVerdict`. */
async function fileReader(req: Request, fileId: string): Promise<FileReader | null> {
  const host = req.headers.host || "unknown";
  const signed = readSignedFileUrl(req.query as Record<string, unknown>);
  if (signed) return signedFileReader(signed, fileId, req.query.thumb === "1", host);

  // Old clients until GRYT-1586, which drops `?t=` once they have had a release to update.
  const raw = req.query.t;
  const token = typeof raw === "string" ? raw : null;
  if (!token) return null;

  const payload = verifyFileToken(token);
  if (!payload) return null;

  if (payload.serverHost !== host) return null;

  try {
    const cfg = await getServerConfig();
    const currentVersion = cfg?.token_version ?? 0;
    if ((payload.tokenVersion ?? 0) !== currentVersion) return null;

    // A file token lives twelve hours against an access token's fifteen
    // minutes, so an ended session would keep reading uploads all day.
    const member = await getUserByServerId(payload.serverUserId);
    if (!member) return null;
    if ((payload.userTokenVersion ?? 0) !== (member.token_version ?? 0)) return null;
  } catch {
    // The config is unreadable, so the version cannot be checked. Refuse rather
    // than serve: this is the path that had no check at all until GRYT-740.
    return null;
  }

  return payload;
}

async function signedFileReader(signed: SignedFileUrl, fileId: string, thumb: boolean, serverHost: string): Promise<FileReader | null> {
  try {
    const cfg = await getServerConfig();
    const member = await getUserByServerId(signed.user);
    if (!member) return null;
    const valid = checkSignedFileUrl(signed, {
      fileId,
      thumb,
      serverHost,
      tokenVersion: cfg?.token_version ?? 0,
      userTokenVersion: member.token_version ?? 0,
    });
    return valid ? { serverUserId: member.server_user_id, grytUserId: member.gryt_user_id } : null;
  } catch {
    return null;
  }
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
        const reader = await fileReader(req, fileId);
        if (!reader) {
          res.status(401).json({ error: "auth_required", message: "A signed link or file token is required to read uploads." });
          return;
        }

        // Somebody else's file answers exactly like no file, so ids are not confirmed.
        const verdict = await fileReadVerdict(fileId, reader.serverUserId, reader.grytUserId);
        if (verdict === "undetermined") {
          res.status(503).json({ error: "unavailable", message: "Could not check that just now. Try again in a moment." });
          return;
        }
        const fileMeta = verdict === "allowed" ? await getFile(fileId) : null;
        if (!fileMeta) { res.status(404).json({ error: "File not found" }); return; }

        const useThumb = req.query.thumb === "1" && fileMeta.thumbnail_key;
        const s3Key = useThumb ? fileMeta.thumbnail_key! : fileMeta.s3_key;
        const totalSize = useThumb ? null : (fileMeta.size ?? null);

        const rangeHeader = req.headers.range;

        // IMPORTANT: do not redirect to S3/MinIO endpoints. In dev those are often localhost,
        // and browsers cannot reach the server's localhost. Stream through the API instead.
        let obj: Awaited<ReturnType<typeof getObject>>;
        try {
          obj = await getObject({ bucket, key: s3Key, range: rangeHeader || undefined });
        } catch (err) {
          if (!(err instanceof RangeNotSatisfiableError)) throw err;
          res.status(416).setHeader("Content-Range", `bytes */${err.size}`);
          res.setHeader("Content-Length", "0");
          res.end();
          return;
        }
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
        // cache would hand one person's file to whoever asked next.
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

        sendStoredBody(body, res, `file ${fileId}`);
      })
      .catch(next);
  },
);
