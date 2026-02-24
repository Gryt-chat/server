import sharp from "sharp";

const ANIMATED_MIME_SET = new Set(["image/gif", "image/webp", "image/avif"]);

export async function processEmojiToOptimizedImage(
  buffer: Buffer,
  mime: string,
): Promise<{ processed: Buffer; ext: string; contentType: string }> {
  const animated = ANIMATED_MIME_SET.has(mime);
  const startedAt = Date.now();
  console.log("[EmojiProcess] start", { mime, animated, bytes: buffer.length });
  const pipeline = sharp(buffer, { animated })
    // Keep aspect ratio; only shrink to max height 128 (width unrestricted).
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

