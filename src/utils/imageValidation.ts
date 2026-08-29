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
 * The real ceiling on how much memory an upload can cost.
 *
 * The byte limits an operator sets are about which files they will accept; this
 * is what stops a small file with absurd dimensions from decoding into
 * gigabytes. 100 MP is roughly a 10000x10000 image, which is far past anything
 * anybody puts on a profile, and decodes to about 400 MB of raw bitmap.
 *
 * Exported because every sharp call that touches an untrusted upload has to
 * carry it, not just the ones in this file.
 */
export const MAX_INPUT_PIXELS = 100_000_000;

/**
 * Raster formats an upload is allowed to be.
 *
 * SVG is deliberately absent, and that is the point of the list. An SVG is a
 * document: it can carry <script>, and a browser asked to render one as a
 * document will run it. Ours were stored byte-for-byte and served back inline
 * as image/svg+xml from the server's own origin, which is a stored-XSS
 * primitive for anyone who can upload — the app renders attachments in <img>,
 * where script does not run, but the URL is reachable directly and in an
 * iframe, where it does.
 *
 * Sniffed rather than taken from the request. The mime came straight from the
 * client, so it said nothing about the bytes behind it.
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
 * The image's dominant colour as #rrggbb, for tinting a surface that stands in
 * for it — a voice tile behind someone's avatar, for instance.
 *
 * The image worker does this for chat uploads, on the way to building their
 * thumbnails. Avatars never reach it: they are resized here, inline, and no
 * image job is ever queued for one. Since this route has already decoded the
 * buffer to make the 256px AVIF, one more pass over it is the cheapest place
 * left to get a colour, and it means a new avatar is tinted correctly the
 * moment it is uploaded rather than on the worker's next sweep.
 *
 * Never throws. A colour is a nicety and must not fail the upload carrying it.
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
