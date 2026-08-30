import mime from "mime-types";

/**
 * How an upload is stored, and what is done to it on the way in (GRYT-761).
 *
 * Its own file, and pure, because it is the one decision in the upload route
 * that has a security answer rather than a mechanical one — and because
 * `uploads.ts` needs express, multer, sharp, ffmpeg and object storage to load,
 * so nothing inside it can be checked.
 *
 * ## What sealing changes
 *
 * A sealed upload was encrypted by the client before it was sent, and the key
 * is inside a sealed message only the conversation's members can open. There is
 * nothing here to validate, nothing to make a thumbnail of, and no dimensions
 * to read: every one of those needs the picture.
 *
 * **The content type is replaced, not trusted.** This is the load-bearing part.
 * Skipping validation while keeping the client's type would let ciphertext
 * labelled `image/svg+xml` be stored under that type and served inline from the
 * API's own origin — the stored-XSS shape the SVG sanitiser exists to prevent,
 * reached by setting a form field. `application/octet-stream` is outside
 * `isInlineSafe`, so the download route hands it over as an attachment with
 * `nosniff` and a sandbox CSP without knowing anything about sealing.
 *
 * **The filename is dropped.** The real one is inside the sealed message with
 * the key. Recording it here would put back the thing the encryption is for: a
 * filename says a great deal about a file, and it goes out in every member
 * list and every message that names the attachment.
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
   * Whether to queue the image worker against it afterwards.
   *
   * False for SVG, and that is not an oversight. The worker hands its input to
   * sharp, sharp renders SVG through librsvg, and storing the vector is what
   * keeps a memory-unsafe parser away from a stranger's bytes. The route
   * returned before reaching the queue for SVG before this decision moved out
   * here, which made the rule true by control flow rather than by saying so.
   */
  queueImageJob: boolean;
}

/**
 * Read the flag off the multipart body.
 *
 * A flag rather than a guess. Ciphertext is indistinguishable from noise, so a
 * server working out for itself whether an upload is sealed would be working
 * out something it can be wrong about, in a way that decides whether the file
 * is validated. Exactly `"1"`: an absent field, an empty one, `"false"` and
 * `"0"` all mean an ordinary upload, and so does anything unexpected.
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
