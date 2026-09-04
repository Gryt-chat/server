import sharp, { type SharpOptions } from "sharp";

export type ImageValidationResult =
  | {
      valid: true;
      width: number;
      height: number;
      pages: number | undefined;
      /** What the bytes actually are, not what the upload claimed. */
      format: string;
    }
  | { valid: false; reason: string };

/**
 * The real ceiling on how much memory an upload can cost — a byte limit does
 * not stop a small file with absurd dimensions decoding into gigabytes.
 * **Every sharp call that touches an untrusted upload has to carry this.**
 */
export const MAX_INPUT_PIXELS = 100_000_000;

/**
 * Raster formats an upload is allowed to be. **SVG is deliberately absent**,
 * which is the point of the list: it is a document, it can carry `<script>`,
 * and served inline from the server's own origin that is stored XSS.
 *
 * Sniffed, not taken from the request — the mime says nothing about the bytes.
 */
const ALLOWED_IMAGE_FORMATS = new Set([
  "jpeg",
  "jpg",
  "png",
  "gif",
  "webp",
  "avif",
  "heif",
  "tiff",
]);

export function isAllowedImageFormat(format: string | undefined): boolean {
  return !!format && ALLOWED_IMAGE_FORMATS.has(format.toLowerCase());
}

/**
 * Validates an image buffer by reading metadata and forcing a single-frame
 * pixel decode.  Catches corrupt / truncated / bomb images before heavier
 * processing that could crash the process via native libvips errors.
 */
export async function validateImage(
  buffer: Buffer,
  opts?: { animated?: boolean },
): Promise<ImageValidationResult> {
  try {
    const base: SharpOptions = {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      ...(opts?.animated ? { animated: true } : {}),
    };

    const meta = await sharp(buffer, base).metadata();
    if (!meta.width || !meta.height) {
      return { valid: false, reason: "Could not determine image dimensions." };
    }

    if (!isAllowedImageFormat(meta.format)) {
      return {
        valid: false,
        reason:
          meta.format === "svg"
            ? "SVG images are not accepted. Please upload a PNG, JPEG, GIF, WebP or AVIF."
            : "That image format is not supported.",
      };
    }

    await sharp(buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .resize(1, 1)
      .raw()
      .toBuffer();

    return {
      valid: true,
      width: meta.width,
      height: meta.height,
      pages: meta.pages,
      format: meta.format ?? "unknown",
    };
  } catch {
    return { valid: false, reason: "Image appears to be corrupt or unreadable." };
  }
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * The image's dominant colour, for tinting a surface that stands in for it.
 * Avatars never reach the image worker, and this route has already decoded the
 * buffer, so one more pass is the cheapest place left to get one.
 *
 * Never throws: a colour must not fail the upload carrying it.
 */
export async function findDominantColor(
  buffer: Buffer,
  opts?: { animated?: boolean },
): Promise<string | null> {
  try {
    const { dominant } = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      ...(opts?.animated ? { pages: 1 } : {}),
    }).stats();

    if (!dominant) return null;

    return `#${toHex(dominant.r)}${toHex(dominant.g)}${toHex(dominant.b)}`;
  } catch {
    return null;
  }
}
