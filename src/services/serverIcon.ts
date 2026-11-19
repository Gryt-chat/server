import consola from "consola";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

import { getServerConfig, insertServerAudit, updateServerConfig } from "../db";
import { deleteObject, putObject, uploadsFolder } from "../storage";
import { MAX_INPUT_PIXELS, validateImage } from "../utils/imageValidation";
import { storageErrorMessage } from "./avatarImage";
import { workerClearsQuarantine } from "./workerCapabilities";
import { reencodeThroughWorker } from "./workerReencode";

/** Eight seconds at 60fps: roughly 0.5-0.7 MB at 256x256, against 1.3 kB for a
    still icon. Generous, because the point is to stop a runaway. */
export const MAX_ICON_FRAMES = 480;

export type ServerIconResult =
  | { ok: true; key: string; iconUrl: string | null }
  | { ok: false; status: number; error: string; message: string };

const INVALID = "Could not process image. Please upload a valid PNG/JPEG/WebP/GIF/AVIF under the size limit.";

/** Best effort: the config is already updated, so a failure leaves a few
    kilobytes rather than failing the request. */
export function deletePreviousIcon(bucket: string, key: string | null | undefined): void {
  if (!key) return;
  deleteObject({ bucket, key }).catch((e) =>
    consola.warn("previous icon delete failed", { key, error: e }),
  );
}

/** A raster icon (not SVG) from the owner's upload or the set-icon admin script. */
export async function saveRasterServerIcon(
  buffer: Buffer,
  iconMime: string,
  safeHost: string,
  actorServerUserId: string | null,
): Promise<ServerIconResult> {
  const bucket = uploadsFolder();
  const isAnimated =
    iconMime === "image/gif" ||
    iconMime === "image/webp" ||
    iconMime === "image/avif";

  // Written out in the worker's jail where there is one, at the same 256px square.
  const fromWorker = workerClearsQuarantine()
    ? await reencodeThroughWorker(buffer, iconMime, "avatars").catch(() => null)
    : undefined;
  if (fromWorker === null) return { ok: false, status: 400, error: "invalid_file", message: INVALID };

  const validation = fromWorker
    ? { valid: true as const, pages: 1 }
    : await validateImage(buffer, { animated: isAnimated });
  if (!validation.valid) return { ok: false, status: 400, error: "invalid_file", message: validation.reason };

  // Drawn at 38 pixels on every server somebody joined, so an uncapped GIF
  // is hundreds of kilobytes each. Refused, not truncated.
  const frames = validation.pages ?? 1;
  if (isAnimated && frames > MAX_ICON_FRAMES) {
    return {
      ok: false,
      status: 400,
      error: "too_many_frames",
      message:
        `This icon has ${frames} frames and the limit is ${MAX_ICON_FRAMES}` +
        ` — about ${MAX_ICON_FRAMES / 60} seconds at 60fps. Shorten it or` +
        ` lower its frame rate and upload it again.`,
    };
  }

  // AVIF holds one frame and sharp stacks an animation into a tall strip, so
  // a 95-frame GIF became a 256x9728 still. Same branch as emojiProcessing.
  const outMime = isAnimated ? "image/webp" : "image/avif";
  const outExt = isAnimated ? "webp" : "avif";

  let out: Buffer;
  if (fromWorker) {
    out = fromWorker.body;
  } else try {
    const pipeline = sharp(buffer, {
      animated: isAnimated,
      failOn: "error",
      // validateImage pixel-checks one page; this decodes every frame, and a
      // modest frame is under the ceiling where two hundred are not.
      limitInputPixels: MAX_INPUT_PIXELS,
    }).resize(256, 256, { fit: "cover" });

    out = isAnimated
      ? await pipeline.webp().toBuffer()
      : await pipeline.avif().toBuffer();
  } catch {
    return { ok: false, status: 400, error: "invalid_file", message: INVALID };
  }

  const key = `server-icons/${safeHost}/${uuidv4()}.${fromWorker ? fromWorker.ext : outExt}`;
  try {
    await putObject({ bucket, key, body: out, contentType: fromWorker ? fromWorker.mime : outMime });
  } catch (e) {
    const raw = e instanceof Error ? e.message : "";
    consola.error("icon upload s3 error", { bucket, key, message: raw });
    return { ok: false, status: 502, error: "s3_error", message: storageErrorMessage(raw, "Icon") };
  }

  const previousIcon = (await getServerConfig())?.icon_url ?? null;
  const updated = await updateServerConfig({
    iconUrl: key, // stored as S3 key; GET /icon streams the object
    isConfigured: true,
  });
  deletePreviousIcon(bucket, previousIcon);

  insertServerAudit({
    actorServerUserId,
    action: "icon_update",
    target: key,
  }).catch((e) => consola.warn("audit log write failed", e));

  return { ok: true, key, iconUrl: updated.icon_url };
}
