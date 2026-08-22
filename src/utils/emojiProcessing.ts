import sharp from "sharp";

import { MAX_INPUT_PIXELS, validateImage } from "./imageValidation";

const ANIMATED_MIME_SET = new Set(["image/gif", "image/webp", "image/avif"]);

export async function processEmojiToOptimizedImage(
  buffer: Buffer,
  mime: string,
): Promise<{ processed: Buffer; ext: string; contentType: string }> {
  const animated = ANIMATED_MIME_SET.has(mime);
  const startedAt = Date.now();
  console.log("[EmojiProcess] start", { mime, animated, bytes: buffer.length });

  const validation = await validateImage(buffer, { animated });
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  // validateImage decodes one page; this decodes all of them, so it carries
  // the ceiling rather than relying on the check that came before it.
  const pipeline = sharp(buffer, { animated, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .resize({ height: 128, withoutEnlargement: true });

  if (animated) {
    const processed = await pipeline.webp({ effort: 6 }).toBuffer();
    console.log("[EmojiProcess] done", { mime, animated, outExt: "webp", outBytes: processed.length, ms: Date.now() - startedAt });
    return { processed, ext: "webp", contentType: "image/webp" };
  }

  const processed = await pipeline.avif().toBuffer();
  console.log("[EmojiProcess] done", { mime, animated, outExt: "avif", outBytes: processed.length, ms: Date.now() - startedAt });
  return { processed, ext: "avif", contentType: "image/avif" };
}

