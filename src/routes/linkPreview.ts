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
   * What the page answered with.
   *
   * A client needs to tell "this site publishes no metadata" from "this page
   * is private or gone", because the second has an honest thing to say and the
   * first only has a hostname. A private GitHub repo is the case that prompted
   * it: GitHub 404s to anyone not signed in, and its 404 page carries GitHub's
   * *own* metadata, so parsing that gives a card titled "Build software
   * better, together" for a link to somebody's repository.
   */
  status: number | null;
}

const cache = new Map<string, { data: LinkPreviewData; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

/**
 * How much of a page to read before giving up on finding its `<head>`.
 *
 * This was 50 KB, which is plenty for most of the web and not enough for some
 * of the sites people paste most. Measured 2026-09-03: MDN closes its head at
 * 5.9 KB, Steam at 8.3 KB, GitHub at 32 KB — but Modrinth's `og:title` sits at
 * byte 246,740 and YouTube's at 699,799. Under the old cap those two returned
 * nothing at all and drew a card with a hostname and an empty grey box.
 *
 * The read stops at `</head>` regardless, so this only decides how long to
 * keep going for a page that never closes one. Almost nothing reaches it.
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

async function fetchPreview(url: string): Promise<LinkPreviewData> {
  const empty: LinkPreviewData = { url, ...EMPTY_PAGE_METADATA, status: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
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

    let { imageWidth, imageHeight } = meta;
    // Only measure the image when the page has not already said how big it is.
    // Most of the web sets og:image:width, and skipping the request saves a
    // round trip on every preview that does.
    if (meta.image && imageWidth === null && imageHeight === null) {
      const checkedImage = await checkPreviewUrl(meta.image);
      if (checkedImage.ok) {
        const measured = await fetchRemoteImageMetadata(meta.image);
        imageWidth = measured.width;
        imageHeight = measured.height;
      }
    }

    return { url, ...meta, imageWidth, imageHeight, status: res.status };
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
