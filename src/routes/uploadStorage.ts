import mime from "mime-types";

/**
 * How an upload is stored, and what is done to it on the way in (GRYT-761).
 *
 * Its own file, and pure, because `uploads.ts` needs express, multer, sharp,
 * ffmpeg and object storage to load, so nothing inside it can be checked.
 *
 * A sealed upload was encrypted before it was sent, so there is nothing to
 * validate, thumbnail or measure. Two things follow:
 *
 * **The content type is replaced, not trusted.** Keeping the client's type
 * while skipping validation lets ciphertext labelled `image/svg+xml` be served
 * inline from the API's own origin — stored XSS reached by setting a form
 * field. `application/octet-stream` is outside `isInlineSafe`.
 *
 * **The filename is dropped.** The real one is in the sealed message with the
 * key, and a filename says a great deal about a file.
 */
export interface UploadStorage {
  /** Where the bytes go in the bucket. */
  key: string;
  /** What the `files` row records, and what the download route serves as. */
  storedMime: string;
  /** What the row records as the original name, or null to record none. */
  originalName: string | null;
  /** Whether the bytes have to decode as one of the raster formats allowed. */
  validateAsImage: boolean;
  /** Whether to sanitise and store this as a vector rather than a raster. */
  treatAsSvg: boolean;
  /** Whether to pull a poster frame out of it. */
  extractVideoThumbnail: boolean;
  /**
   * Whether to queue the image worker afterwards. **False for SVG**, which is
   * not an oversight: the worker hands its input to sharp, and sharp renders
   * SVG through librsvg.
   */
  queueImageJob: boolean;
}

/**
 * Read the flag off the multipart body. A flag rather than a guess: ciphertext
 * is indistinguishable from noise, and getting it wrong decides whether the
 * file is validated. Exactly `"1"`; anything else is an ordinary upload.
 */
export function isSealedUpload(body: unknown): boolean {
  const value = (body as { sealed?: unknown } | null | undefined)?.sealed;
  return value === "1";
}

export function storageForUpload({
  sealed,
  fileId,
  mimetype,
  originalName,
}: {
  sealed: boolean;
  fileId: string;
  mimetype: string | undefined;
  originalName: string | undefined;
}): UploadStorage {
  if (sealed) {
    return {
      key: `uploads/${fileId}.bin`,
      storedMime: "application/octet-stream",
      originalName: null,
      validateAsImage: false,
      treatAsSvg: false,
      extractVideoThumbnail: false,
      queueImageJob: false,
    };
  }

  const fileMime = (mimetype || "").toLowerCase();

  return {
    key: `uploads/${fileId}.${mime.extension(mimetype || "") || "bin"}`,
    storedMime: mimetype || "application/octet-stream",
    originalName: originalName || null,
    validateAsImage: fileMime.startsWith("image/") && fileMime !== "image/svg+xml",
    treatAsSvg: fileMime === "image/svg+xml",
    extractVideoThumbnail: fileMime.startsWith("video/"),
    queueImageJob: fileMime.startsWith("image/") && fileMime !== "image/svg+xml",
  };
}
