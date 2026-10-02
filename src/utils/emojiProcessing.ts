import { consumeRasterUpload } from "../services/rasterUpload";

export async function processEmojiToOptimizedImage(
  buffer: Buffer,
  _mime: string,
  uploadedBy: string | null = null,
): Promise<{ processed: Buffer; ext: string; contentType: string }> {
  return consumeRasterUpload({ bucket: process.env.S3_BUCKET as string, bytes: buffer, uploadedBy, originalName: null,
    profile: "emoji", width: 128, height: 128, thumbWidth: 128, thumbHeight: 128, maxBytes: 64 * 1024 * 1024 });
}
