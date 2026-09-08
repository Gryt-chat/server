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

/** A byte limit does not stop a small file with absurd dimensions. Every sharp
    call that touches an untrusted upload has to carry this. */
export const MAX_INPUT_PIXELS = 100_000_000;

/** SVG is deliberately absent: it is a document that can carry `<script>`.
    Sniffed, not taken from the request. */
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

/** Forces a single-frame decode, so a corrupt or bomb image fails here rather
    than in a native libvips error later. */
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

/** Avatars never reach the image worker, and this route already decoded the
    buffer. Never throws: a colour must not fail its upload. */
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
