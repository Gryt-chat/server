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
