import consola from "consola";
import sharp from "sharp";

import { MAX_INPUT_PIXELS } from "./imageValidation";
import { fetchFollowingSafely, type FetchGuard } from "./safePreviewFetch";

export type RemoteImageMetadata = {
  url: string;
  mime: string | null;
  width: number | null;
  height: number | null;
};

type CacheEntry = { data: RemoteImageMetadata; fetchedAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;

// Unref'd so importing this module does not by itself hold the process open;
// it only sweeps a metadata cache. Same reasoning as the nonce sweeper in auth/identity.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 2) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

async function readUpToBytes(res: Response, maxBytes: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        bytesRead += value.length;
      }
    }
  } finally {
    reader.cancel().catch((e) => consola.warn("reader cancel failed", e));
  }
  if (chunks.length === 0) return Buffer.from([]);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** `guard` is for tests; see `fetchFollowingSafely`. */
export async function fetchRemoteImageMetadata(url: string, guard?: FetchGuard): Promise<RemoteImageMetadata> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const empty: RemoteImageMetadata = { url, mime: null, width: null, height: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const fetched = await fetchFollowingSafely(url, controller.signal, "image/*", guard);
    if ("blocked" in fetched) return empty;
    const { res } = fetched;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok || !contentType.startsWith("image/")) {
      await res.body?.cancel().catch(() => {});
      return empty;
    }

    const buf = await readUpToBytes(res, 450_000);
    if (buf === null) return empty;

    const meta = await sharp(buf, { animated: true, failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata().catch(() => null);
    const data: RemoteImageMetadata = {
      url,
      mime: contentType || null,
      width: meta?.width ?? null,
      height: meta?.height ?? null,
    };

    if (cache.size >= MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest) cache.delete(oldest);
    }
    cache.set(url, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    consola.debug("remote image metadata failed", { url, err });
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

