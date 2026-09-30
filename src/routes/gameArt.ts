/**
 * A game's art, fetched once from Steam's image server, cached on disk and served from
 * here (GRYT-1602). Gryt never contacts Discord, so there's no fallback to its covers.
 */

import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

import consola from "consola";
import { Router } from "express";
import sharp from "sharp";

import { httpRateLimit, RL_HTTP_FILE } from "../middleware/rateLimitHttp";

const LIST_URL = "https://cdn.jsdelivr.net/gh/Gryt-chat/rich-presence@main/games.json";
const LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** A game with no art, or an upstream that failed, is not asked again for this long. */
const MISS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;
/** How many games are fetched upstream at once; the rest wait. */
const MAX_IN_FLIGHT = 4;

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

async function fetchImage(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) return null;
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MAX_UPSTREAM_BYTES) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_UPSTREAM_BYTES) return null;
  return sharp(body, { limitInputPixels: 4096 * 4096 })
    .resize(640, 300, { fit: "cover", position: "attention" })
    .webp({ quality: 72 })
    .toBuffer();
}

function cacheDir(): string {
  const dir = join(process.env.DATA_DIR || "./data", "game-art");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** The art for one game, from disk if it's been fetched before. Null when there's none. */
export async function gameArt(appId: string): Promise<Buffer | null> {
  const file = join(cacheDir(), `${appId}.webp`);
  try {
    return await readFile(file);
  } catch {
    // Not fetched yet.
  }
  const missed = misses.get(appId);
  if (missed && Date.now() - missed < MISS_TTL_MS) return null;

  let pending = inFlight.get(appId);
  if (!pending) {
    pending = slot(async () => {
      const src = (await loadList()).get(appId);
      for (const url of src ? artUrls(src) : []) {
        try {
          const art = await fetchImage(url);
          if (art) {
            await writeFile(file, art);
            return art;
          }
        } catch (err) {
          consola.debug(`game art: ${url} failed`, err);
        }
      }
      misses.set(appId, Date.now());
      return null;
    }).finally(() => inFlight.delete(appId));
    inFlight.set(appId, pending);
  }
  return pending;
}

const router = Router();

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
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(art);
});

export { router as gameArtRouter };
