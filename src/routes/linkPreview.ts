import { Router } from "express";
import consola from "consola";

import { requireBearerToken } from "../middleware/requireBearerToken";
import { ensurePermission } from "../middleware/requirePermission";
import { httpRateLimit, RL_HTTP_OUTBOUND } from "../middleware/rateLimitHttp";
import { fetchRemoteImageMetadata } from "../utils/remoteImageMetadata";
import {
  charsetFromContentType,
  EMPTY_PAGE_METADATA,
  parsePageMetadata,
} from "../utils/pageMetadata";
import { checkPreviewUrl } from "../utils/previewUrlSafety";
import { fetchFollowingSafely } from "../utils/safePreviewFetch";
import { resolverFor, type LinkResolver, type ResolvedMetadata } from "../utils/linkResolvers";

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageAlt: string | null;
  siteName: string | null;
  favicon: string | null;
  /** The page's own brand colour, when it declares one. */
  themeColor: string | null;
  /** `og:type`, so a client can tell an article from a video from a song. */
  type: string | null;
  author: string | null;
  publishedAt: string | null;
  /** Its presence is how a client knows there is a real player, without
      keeping a list of which sites have one. */
  oembedUrl: string | null;
  /** So a client can tell "no metadata" from "private or gone": a private
      GitHub repo 404s with GitHub's own metadata attached. */
  status: number | null;
}

const FRESH_MS = 60 * 60 * 1000;
/** Past fresh, an entry is only an answer for when the refresh fails. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 2000;

/** Measured: MDN closes its head at 5.9 KB, YouTube's `og:title` sits at byte
    699,799. The read stops at `</head>`, so this bounds a page that has none. */
const MAX_BYTES = 1_048_576;

const FETCH_TIMEOUT_MS = 8000;
/** Shorter than the page fetch and separate from it, so a hung resolver leaves
    the fallback its whole budget. */
const RESOLVER_TIMEOUT_MS = 5000;

/** Read a response body until the head closes, the cap, or the end. */
async function readHead(res: Response, charset: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder(charset);
  let html = "";
  let bytesRead = 0;

  try {
    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value.length;
      if (html.includes("</head>")) break;
    }
  } finally {
    reader.cancel().catch((e) => consola.debug("preview reader cancel failed", e));
  }

  return html;
}

/** Generous rather than tight — one design endpoint answers 86 KB — but still a
    bound on a response from somebody else's server. */
const MAX_JSON_BYTES = 512 * 1024;

/** Handed in rather than imported, so a resolver cannot reach the network
    another way. Same host check, abort signal, size cap and JSON refusal. */
function jsonFetcher(signal: AbortSignal, fetchPage: FetchPreviewDeps["fetchPage"]) {
  return async (target: string): Promise<unknown> => {
    const fetched = await fetchPage(target, signal, "application/json");
    if ("blocked" in fetched) return null;

    const { res } = fetched;
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    if (Number(res.headers.get("content-length") || 0) > MAX_JSON_BYTES) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
}

/** The card sets `aspect-ratio` from these, so without them the message reflows
    as the picture loads. Only when neither is known. */
async function measureIfUnsized(
  meta: Pick<LinkPreviewData, "image" | "imageWidth" | "imageHeight">,
): Promise<{ imageWidth: number | null; imageHeight: number | null }> {
  const { image, imageWidth, imageHeight } = meta;
  if (!image || imageWidth !== null || imageHeight !== null) {
    return { imageWidth, imageHeight };
  }

  const checked = await checkPreviewUrl(image);
  if (!checked.ok) return { imageWidth, imageHeight };

  const measured = await fetchRemoteImageMetadata(image);
  return { imageWidth: measured.width, imageHeight: measured.height };
}

export interface FetchPreviewDeps {
  resolverFor: typeof resolverFor;
  fetchPage: (url: string, signal: AbortSignal, accept: string) => ReturnType<typeof fetchFollowingSafely>;
  resolverTimeoutMs: number;
  pageTimeoutMs: number;
}

const realDeps: FetchPreviewDeps = {
  resolverFor,
  fetchPage: fetchFollowingSafely,
  resolverTimeoutMs: RESOLVER_TIMEOUT_MS,
  pageTimeoutMs: FETCH_TIMEOUT_MS,
};

/** Raced against the timer too, so a resolver awaiting something that ignores the
    signal still gives up on time. */
async function resolveWithin(
  resolver: LinkResolver,
  url: URL,
  fetchPage: FetchPreviewDeps["fetchPage"],
  ms: number,
): Promise<ResolvedMetadata | null> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`resolver timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([
      resolver.resolve(url, jsonFetcher(controller.signal, fetchPage)),
      expired,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPreview(
  url: string,
  deps: FetchPreviewDeps = realDeps,
): Promise<LinkPreviewData> {
  const empty: LinkPreviewData = { url, ...EMPTY_PAGE_METADATA, status: null };

  // A resolver returning null falls through to the ordinary fetch below.
  // `status: 200` because the card came from somewhere that answered.
  const resolver = deps.resolverFor(new URL(url));
  if (resolver) {
    try {
      const resolved = await resolveWithin(resolver, new URL(url), deps.fetchPage, deps.resolverTimeoutMs);
      if (resolved) {
        const card = { ...empty, ...resolved, url, status: 200 };
        // A resolver builds its own image URL, so there is never an
        // `og:image:width` to take the size from.
        return { ...card, ...(await measureIfUnsized(card)) };
      }
    } catch (err) {
      consola.warn(`[link-preview] resolver ${resolver.id} failed for ${url}`, err);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.pageTimeoutMs);

  let page: { html: string; finalUrl: string; status: number };
  try {
    const fetched = await deps.fetchPage(url, controller.signal, "text/html,application/xhtml+xml");
    if ("blocked" in fetched) return empty;

    const { res, finalUrl } = fetched;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // The status is the whole answer here. An error page's metadata belongs
      // to the error page, not to the link somebody pasted.
      return { ...empty, status: res.status };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      await res.body?.cancel().catch(() => {});
      return { ...empty, status: res.status };
    }

    const html = await readHead(res, charsetFromContentType(contentType));
    page = { html, finalUrl, status: res.status };
  } finally {
    clearTimeout(timeout);
  }

  const meta = parsePageMetadata(page.html, page.finalUrl);
  // Outside the page budget: the image fetch carries its own timeout.
  const measured = await measureIfUnsized(meta);

  return { url, ...meta, ...measured, status: page.status };
}

type Entry = { data: LinkPreviewData; fetchedAt: number };

export type PreviewLookup =
  | { data: LinkPreviewData; stale: boolean }
  | { refused: true }
  | { failed: unknown };

/**
 * `charge` runs only when this request starts an upstream fetch, so a cache hit
 * or joining a fetch already in flight costs nothing against the limit.
 */
export function createPreviewCache(
  fetchOne: (url: string) => Promise<LinkPreviewData> = fetchPreview,
  now: () => number = Date.now,
) {
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<LinkPreviewData>>();

  function store(url: string, data: LinkPreviewData) {
    entries.delete(url);
    if (entries.size >= MAX_CACHE_SIZE) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(url, { data, fetchedAt: now() });
  }

  async function lookup(url: string, charge: () => boolean): Promise<PreviewLookup> {
    const entry = entries.get(url);
    if (entry && now() - entry.fetchedAt < FRESH_MS) return { data: entry.data, stale: false };

    let pending = inFlight.get(url);
    if (!pending) {
      if (!charge()) return { refused: true };
      pending = fetchOne(url)
        .then((data) => {
          store(url, data);
          return data;
        })
        .finally(() => inFlight.delete(url));
      inFlight.set(url, pending);
    }

    try {
      return { data: await pending, stale: false };
    } catch (err) {
      const previous = entries.get(url);
      if (previous && now() - previous.fetchedAt < MAX_AGE_MS) {
        return { data: previous.data, stale: true };
      }
      return { failed: err };
    }
  }

  function sweep() {
    const cutoff = now() - MAX_AGE_MS;
    for (const [key, entry] of entries) {
      if (entry.fetchedAt < cutoff) entries.delete(key);
    }
  }

  return { lookup, sweep, size: () => entries.size };
}

const previews = createPreviewCache();
const limitOutbound = httpRateLimit("http:outbound", RL_HTTP_OUTBOUND);

const router = Router();

router.get("/", requireBearerToken, async (req, res) => {
  if (!(await ensurePermission(req, res, "use_link_previews"))) return;

  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) {
    res.status(400).json({ error: "missing_url", message: "URL parameter is required" });
    return;
  }

  const checked = await checkPreviewUrl(url);
  if (!checked.ok) {
    const message =
      checked.reason === "blocked_host" ? "Private URLs are not allowed" : "Invalid URL";
    res.status(400).json({ error: checked.reason, message });
    return;
  }

  // The limiter answers the 429 itself when it refuses.
  const found = await previews.lookup(url, () => {
    let allowed = false;
    limitOutbound(req, res, () => {
      allowed = true;
    });
    return allowed;
  });

  if ("refused" in found) return;
  if ("failed" in found) {
    consola.error("Link preview fetch failed:", url, found.failed);
    res.status(502).json({ error: "fetch_failed", message: "Failed to fetch link preview" });
    return;
  }
  if (found.stale) consola.warn("[link-preview] refresh failed, serving the previous card", url);
  res.json(found.data);
});

// Unref'd, so importing this module does not hold the process open for a
// preview cache sweep. Same as the nonce sweeper in auth/identity.
setInterval(() => previews.sweep(), 5 * 60 * 1000).unref();

export const linkPreviewRouter = router;
