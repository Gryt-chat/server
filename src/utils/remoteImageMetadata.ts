import consola from "consola";
import sharp from "sharp";

export type RemoteImageMetadata = {
  url: string;
  mime: string | null;
  width: number | null;
  height: number | null;
};

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "[::1]",
]);

export function isBlockedHost(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (/^(127|10|192\.168)\.\d/.test(hostname)) return true;
  if (hostname.startsWith("172.") && /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

type CacheEntry = { data: RemoteImageMetadata; fetchedAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 2) cache.delete(key);
  }
}, 5 * 60 * 1000);

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

export async function fetchRemoteImageMetadata(url: string): Promise<RemoteImageMetadata> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const empty: RemoteImageMetadata = { url, mime: null, width: null, height: null };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return empty;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return empty;
  if (isBlockedHost(parsed.hostname)) return empty;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "image/*",
        "User-Agent": "Mozilla/5.0 (compatible; GrytBot/1.0; +https://gryt.chat)",
      },
      redirect: "follow",
    });
    if (!res.ok) return empty;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return empty;

    const buf = await readUpToBytes(res, 450_000);
    if (buf === null) return empty;

    const meta = await sharp(buf, { animated: true }).metadata().catch(() => null);
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

