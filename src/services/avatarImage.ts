import { AVATAR_MAX_PX, AVATAR_THUMB_PX } from "../constants/media";
import { processRasterUpload, RasterProcessingError } from "./rasterUpload";

export interface PictureBox { width: number; height: number; thumbWidth: number; thumbHeight: number }
const AVATAR_BOX: PictureBox = { width: AVATAR_MAX_PX, height: AVATAR_MAX_PX, thumbWidth: AVATAR_THUMB_PX, thumbHeight: AVATAR_THUMB_PX };

export type StoredAvatarPicture =
  | { ok: true; fileId: string; processing: boolean }
  | { ok: false; status: 400 | 502 | 503; error: "invalid_file" | "s3_error"; message: string };

export async function storeAvatarPicture(input: {
  bucket: string;
  bytes: Buffer;
  mime: string;
  originalName: string | null;
  uploadedBy: string;
  maxBytes: number;
  what: string;
  box?: PictureBox;
  prefix?: string;
}): Promise<StoredAvatarPicture> {
  try {
    const box = input.box ?? AVATAR_BOX;
    const file = await processRasterUpload({ ...box, bucket: input.bucket, bytes: input.bytes, uploadedBy: input.uploadedBy,
      originalName: input.originalName, maxBytes: input.maxBytes, profile: "avatar" });
    return { ok: true, fileId: file.file_id, processing: false };
  } catch (error) {
    if (error instanceof RasterProcessingError) return { ok: false, status: error.status, error: "invalid_file", message: error.message };
    return { ok: false, status: 502, error: "s3_error", message: `${input.what} could not be stored.` };
  }
}
