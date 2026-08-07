import sharp from "sharp";

export type ImageValidationResult =
  | { valid: true; width: number; height: number; pages: number | undefined }
  | { valid: false; reason: string };

const MAX_INPUT_PIXELS = 100_000_000;

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
    const base: sharp.SharpOptions = {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      ...(opts?.animated ? { animated: true } : {}),
    };

    const meta = await sharp(buffer, base).metadata();
    if (!meta.width || !meta.height) {
      return { valid: false, reason: "Could not determine image dimensions." };
    }

    await sharp(buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .resize(1, 1)
      .raw()
      .toBuffer();

    return { valid: true, width: meta.width, height: meta.height, pages: meta.pages };
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
