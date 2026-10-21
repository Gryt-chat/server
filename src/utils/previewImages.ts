import { createHash } from "node:crypto";

import { fetchFollowingSafely } from "./safePreviewFetch";

/**
 * Link preview pictures and icons, fetched by the server (2026-10-21), so a client showing a
 * card never contacts the linked site. Only URLs a preview named can be served: no open proxy.
 */

/** Raster only. An SVG can carry script, and these are served from the API's own origin. */
const SERVABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/x-icon", "image/vnd.microsoft.icon"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_KNOWN = 4000;
/** All cached pictures together, so a run of large ones can't fill the server's memory. */
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export interface PreviewImage {
  body: Buffer;
  type: string;
}

type Fetcher = (url: string, signal: AbortSignal, accept: string) => ReturnType<typeof fetchFollowingSafely>;

export function previewImageId(url: string): string {
  return `lp-${createHash("sha256").update(url).digest("base64url").slice(0, 32)}`;
}

/** Reads at most `max` bytes, or null past it. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createPreviewImages(fetchOne: Fetcher = fetchFollowingSafely, now: () => number = Date.now) {
  const known = new Map<string, string>();
  const cached = new Map<string, PreviewImage & { at: number }>();
  const inFlight = new Map<string, Promise<PreviewImage | null>>();
  let cachedBytes = 0;

  /** Records a URL a preview named, and returns the id a client asks for it by. */
  function remember(url: string | null): string | null {
    if (!url) return null;
    const id = previewImageId(url);
    known.delete(id);
    if (known.size >= MAX_KNOWN) known.delete(known.keys().next().value as string);
    known.set(id, url);
    return id;
  }

  function keep(id: string, image: PreviewImage) {
    const old = cached.get(id);
    if (old) cachedBytes -= old.body.byteLength;
    cached.delete(id);
    while (cachedBytes + image.body.byteLength > MAX_CACHED_BYTES && cached.size > 0) {
      const [oldest, entry] = cached.entries().next().value as [string, PreviewImage];
      cached.delete(oldest);
      cachedBytes -= entry.body.byteLength;
    }
    cached.set(id, { ...image, at: now() });
    cachedBytes += image.body.byteLength;
  }

  async function fetchImage(url: string): Promise<PreviewImage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const fetched = await fetchOne(url, controller.signal, "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon");
      if ("blocked" in fetched) return null;
      const { res } = fetched;
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!res.ok || !SERVABLE.has(type)) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const body = await readCapped(res, MAX_IMAGE_BYTES);
      return body ? { body, type } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The picture for an id a preview handed out, fetched once and then kept for a day. */
  async function load(id: string): Promise<PreviewImage | null> {
    const hit = cached.get(id);
    if (hit && now() - hit.at < KEEP_MS) return hit;
    const url = known.get(id);
    if (!url) return null;
    let pending = inFlight.get(id);
    if (!pending) {
      pending = fetchImage(url)
        .then((image) => {
          if (image) keep(id, image);
          return image;
        })
        .finally(() => inFlight.delete(id));
      inFlight.set(id, pending);
    }
    return pending;
  }

  return { remember, load, cachedBytes: () => cachedBytes };
}
