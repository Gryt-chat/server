/**
 * A game's art, fetched once from Steam's image server, cached on disk and served from
 * here (GRYT-1602). Gryt never contacts Discord, so there's no fallback to its covers.
 */

import { existsSync, mkdirSync } from "fs";
import { readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";

import consola from "consola";
import { Router } from "express";
import sharp from "sharp";

import { httpRateLimit, RL_HTTP_FILE } from "../middleware/rateLimitHttp";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { ensurePermission } from "../middleware/requirePermission";

const LIST_URL = "https://cdn.jsdelivr.net/gh/Gryt-chat/rich-presence@main/games.json";
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** A game with no art, or an upstream that failed, is not asked again for this long. */
const MISS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;
/** How many games are fetched upstream at once; the rest wait. */
const MAX_IN_FLIGHT = 4;
/** How often a cached picture is checked against Steam. A check with no change downloads nothing. */
const RECHECK_MS = 24 * 60 * 60 * 1000;

interface ArtSource {
  steam?: string;
}

let list: Map<string, ArtSource> | null = null;
let listAt = 0;
let listLoading: Promise<Map<string, ArtSource>> | null = null;
const misses = new Map<string, number>();
const inFlight = new Map<string, Promise<Buffer | null>>();
let running = 0;
const queue: (() => void)[] = [];

/** Only a numeric Steam app id is kept, so no other URL can be built. */
export function readArtList(value: unknown): Map<string, ArtSource> {
  const out = new Map<string, ArtSource>();
  const list = Array.isArray(value) ? value : (value as { games?: unknown } | null)?.games;
  if (!Array.isArray(list)) return out;
  for (const raw of list.slice(0, 50_000)) {
    const e = raw as Record<string, unknown> | null;
    const id = typeof e?.id === "string" && /^\d{1,32}$/.test(e.id) ? e.id : "";
    if (!id) continue;
    const src: ArtSource = {};
    if (typeof e?.steam === "string" && /^\d{1,12}$/.test(e.steam)) src.steam = e.steam;
    if (src.steam) out.set(id, src);
  }
  return out;
}

/** Steam's header, the only source: already wide, and not Discord. */
export function artUrls(src: ArtSource): string[] {
  return src.steam ? [`https://cdn.cloudflare.steamstatic.com/steam/apps/${src.steam}/header.jpg`] : [];
}

async function loadList(): Promise<Map<string, ArtSource>> {
  if (list && Date.now() - listAt < LIST_TTL_MS) return list;
  listLoading ??= (async () => {
    try {
      const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const next = readArtList(await res.json());
        if (next.size > 100) {
          list = next;
          listAt = Date.now();
        }
      }
    } catch (err) {
      consola.warn("game art: couldn't refresh the game list", err);
    }
    listLoading = null;
    return list ?? new Map();
  })();
  return listLoading;
}

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => queue.push(resolve));
  running++;
  try {
    return await run();
  } finally {
    running--;
    queue.shift()?.();
  }
}

interface Validators {
  etag?: string;
  lastModified?: string;
  checkedAt: number;
}

/** A new picture, `"same"` when Steam says it hasn't changed, or null when there's none. */
async function fetchImage(url: string, known?: Validators): Promise<{ art: Buffer; meta: Validators } | "same" | null> {
  const headers: Record<string, string> = {};
  if (known?.etag) headers["If-None-Match"] = known.etag;
  if (known?.lastModified) headers["If-Modified-Since"] = known.lastModified;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error", headers });
  if (res.status === 304) return "same";
  if (!res.ok) return null;
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MAX_UPSTREAM_BYTES) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_UPSTREAM_BYTES) return null;
  const art = await sharp(body, { limitInputPixels: 4096 * 4096 })
    .resize(640, 300, { fit: "cover", position: "attention" })
    .webp({ quality: 72 })
    .toBuffer();
  const meta: Validators = { checkedAt: Date.now() };
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  if (etag) meta.etag = etag;
  if (lastModified) meta.lastModified = lastModified;
  return { art, meta };
}

async function readMeta(file: string): Promise<Validators | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Validators;
  } catch {
    return undefined;
  }
}

function cacheDir(): string {
  const dir = join(process.env.DATA_DIR || "./data", "game-art");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fetches or rechecks one game's art. Deduplicated per game and limited to a few at once. */
function refresh(appId: string, known?: Validators): Promise<Buffer | null> {
  let pending = inFlight.get(appId);
  if (pending) return pending;
  const file = join(cacheDir(), `${appId}.webp`);
  const metaFile = join(cacheDir(), `${appId}.json`);
  pending = slot(async () => {
    const src = (await loadList()).get(appId);
    for (const url of src ? artUrls(src) : []) {
      try {
        const got = await fetchImage(url, known);
        if (got === "same") {
          await writeFile(metaFile, JSON.stringify({ ...known, checkedAt: Date.now() }));
          return null;
        }
        if (got) {
          await writeFile(file, got.art);
          await writeFile(metaFile, JSON.stringify(got.meta));
          return got.art;
        }
      } catch (err) {
        consola.debug(`game art: ${url} failed`, err);
      }
    }
    if (!known) misses.set(appId, Date.now());
    return null;
  }).finally(() => inFlight.delete(appId));
  inFlight.set(appId, pending);
  return pending;
}

/** The art for one game, from disk if it's been fetched before. Null when there's none. */
export async function gameArt(appId: string): Promise<Buffer | null> {
  const file = join(cacheDir(), `${appId}.webp`);
  try {
    const art = await readFile(file);
    // Serve what's on disk now; a day-old copy is checked against Steam in the background.
    const meta = await readMeta(join(cacheDir(), `${appId}.json`));
    if (!meta || Date.now() - meta.checkedAt > RECHECK_MS) void refresh(appId, meta ?? { checkedAt: 0 }).catch(() => null);
    return art;
  } catch {
    // Not fetched yet.
  }
  const missed = misses.get(appId);
  if (missed && Date.now() - missed < MISS_TTL_MS) return null;
  return refresh(appId);
}

/** How much the cache holds, for server settings. */
export async function gameArtCacheSize(): Promise<{ games: number; bytes: number }> {
  let games = 0;
  let bytes = 0;
  for (const name of await readdir(cacheDir()).catch(() => [] as string[])) {
    const info = await stat(join(cacheDir(), name)).catch(() => null);
    if (!info?.isFile()) continue;
    bytes += info.size;
    if (name.endsWith(".webp")) games += 1;
  }
  return { games, bytes };
}

/** Empties the cache. Each game's art is fetched again the next time somebody plays it. */
export async function clearGameArtCache(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true });
  misses.clear();
}

const router = Router();

/* Before /:appId, so "cache" is never read as an id. Only for people who manage the server. */
router.get("/cache", requireBearerToken, async (req, res) => {
  if (!(await ensurePermission(req, res, "manage_server"))) return;
  res.json(await gameArtCacheSize());
});

router.delete("/cache", requireBearerToken, async (req, res) => {
  if (!(await ensurePermission(req, res, "manage_server"))) return;
  await clearGameArtCache();
  res.json({ games: 0, bytes: 0 });
});

router.get("/:appId", httpRateLimit("http:game-art", RL_HTTP_FILE), async (req, res) => {
  const appId = String(req.params.appId);
  if (!/^\d{17,20}$/.test(appId)) {
    res.status(400).end();
    return;
  }
  const art = await gameArt(appId).catch(() => null);
  if (!art) {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "image/webp");
  // A day, so a new picture from Steam reaches people within about a day of the server seeing it.
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(art);
});

export { router as gameArtRouter };
