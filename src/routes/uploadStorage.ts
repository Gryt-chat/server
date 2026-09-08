import mime from "mime-types";

/** A sealed upload cannot be validated, so its content type is replaced rather
    than trusted and its filename is dropped. */
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
  /** False for SVG, which is not an oversight: the worker hands its input to
      sharp, and sharp renders SVG through librsvg. */
  queueImageJob: boolean;
}

/** A flag rather than a guess, because ciphertext is indistinguishable from
    noise. Exactly `"1"`; anything else is an ordinary upload. */
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
