import { Router } from "express";
import consola from "consola";

import { requireBearerToken } from "../middleware/requireBearerToken";
import { ensurePermission } from "../middleware/requirePermission";
import { fetchRemoteImageMetadata } from "../utils/remoteImageMetadata";
import {
  charsetFromContentType,
  EMPTY_PAGE_METADATA,
  parsePageMetadata,
} from "../utils/pageMetadata";
import { checkPreviewUrl } from "../utils/previewUrlSafety";
import { resolverFor } from "../utils/linkResolvers";

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
  /**
   * The oEmbed endpoint the page advertises, if it advertises one.
   *
   * Its presence is what tells a client there is a real player to be had
   * without keeping a list of which sites have one. See the oEmbed route.
   */
  oembedUrl: string | null;
  /**
   * What the page answered with, so a client can tell "publishes no metadata"
   * from "private or gone". A private GitHub repo 404s with GitHub's own
   * metadata, which parses into a card titled "Build software better, together".
   */
  status: number | null;
}

const cache = new Map<string, { data: LinkPreviewData; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

/**
 * How much of a page to read before giving up on its `<head>`. Measured
 * 2026-09-03: MDN closes at 5.9 KB and GitHub at 32 KB, but Modrinth's
 * `og:title` sits at byte 246,740 and YouTube's at 699,799.
 *
 * The read stops at `</head>` regardless, so this only bounds a page that never
 * closes one.
 */
const MAX_BYTES = 1_048_576;

const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL, checking every hop rather than only the one that was asked for.
 *
 * `redirect: "follow"` hands the whole chain to undici, which will happily
 * land on `http://169.254.169.254/` if that is where the third hop points.
 * Following by hand costs a loop and means the check applies to the address
 * actually connected to.
 */
async function fetchFollowingSafely(
  startUrl: string,
  signal: AbortSignal,
  accept: string,
): Promise<{ res: Response; finalUrl: string } | { blocked: true }> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await checkPreviewUrl(current);
    if (!checked.ok) return { blocked: true };

    const res = await fetch(current, {
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GrytBot/1.0; +https://gryt.chat)",
        Accept: accept,
        "Accept-Language": "en;q=0.9,*;q=0.5",
      },
    });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Drain the redirect body so the socket goes back to the pool.
      await res.body?.cancel().catch(() => {});
      try {
        current = new URL(location, current).href;
      } catch {
        return { blocked: true };
      }
      continue;
    }

    return { res, finalUrl: current };
  }

  return { blocked: true };
}

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

/**
 * How much JSON a resolver may read. Their design endpoint answers 86 KB for
 * one model, most of which is instances and comments that get thrown away, so
 * this is generous rather than tight — but it is still a bound on a response
 * from somebody else's server.
 */
const MAX_JSON_BYTES = 512 * 1024;

/**
 * The one door a resolver has to the network (GRYT-913).
 *
 * Handed in rather than imported by `linkResolvers.ts`, so a resolver cannot
 * quietly reach the network another way and that module stays testable without
 * one. Everything guarding the ordinary path applies here: the same
 * hop-by-hop host check, the same abort signal, a size cap, and a refusal to
 * parse anything that does not call itself JSON.
 */
function jsonFetcher(signal: AbortSignal) {
  return async (target: string): Promise<unknown> => {
    const fetched = await fetchFollowingSafely(target, signal, "application/json");
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

/**
 * The image's real size, when whoever gave us the URL did not say.
 *
 * The card sets `aspect-ratio` from these and leaves a gap the right shape
 * while the picture loads; without them the message reflows underneath
 * somebody as it arrives.
 *
 * Only when neither is known. Most of the web sets `og:image:width`, and
 * skipping the request saves a round trip on every preview that does — a
 * resolver, which builds its own image URL, never does.
 */
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

async function fetchPreview(url: string): Promise<LinkPreviewData> {
  const empty: LinkPreviewData = { url, ...EMPTY_PAGE_METADATA, status: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    /*
     * A site-specific answer first, where there is one.
     *
     * Only for a host that has a resolver and a URL it recognises, so this
     * costs nothing on the rest of the web. A resolver returning null — the id
     * was not found, the request failed, the shape was not what it expected —
     * falls through to the ordinary fetch below, which is what happened before
     * this existed.
     *
     * `status: 200` because the card came from somewhere that answered. The
     * client reads that field to tell "publishes no metadata" from "gone", and
     * the HTML page's own 403 is not the answer to what happened here.
     */
    const resolver = resolverFor(new URL(url));
    if (resolver) {
      try {
        const resolved = await resolver.resolve(new URL(url), jsonFetcher(controller.signal));
        if (resolved) {
          const card = { ...empty, ...resolved, url, status: 200 };
          // Measured here too. A resolver builds its own image URL, so there is
          // never an `og:image:width` to take the size from, and a card with no
          // aspect ratio reflows the message under somebody as it loads.
          return { ...card, ...(await measureIfUnsized(card)) };
        }
      } catch (err) {
        consola.warn(`[link-preview] resolver ${resolver.id} failed for ${url}`, err);
      }
    }

    const fetched = await fetchFollowingSafely(
      url,
      controller.signal,
      "text/html,application/xhtml+xml",
    );
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
    const meta = parsePageMetadata(html, finalUrl);

    const measured = await measureIfUnsized(meta);

    return { url, ...meta, ...measured, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}

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

  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    res.json(cached.data);
    return;
  }

  try {
    const data = await fetchPreview(url);

    if (cache.size >= MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(url, { data, fetchedAt: Date.now() });

    res.json(data);
  } catch (err) {
    consola.error("Link preview fetch failed:", url, err);
    res.status(502).json({ error: "fetch_failed", message: "Failed to fetch link preview" });
  }
});

// Unref'd so importing this module does not by itself hold the process open;
// it only sweeps a preview cache. Same reasoning as the nonce sweeper in
// auth/identity.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 2) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

export const linkPreviewRouter = router;
