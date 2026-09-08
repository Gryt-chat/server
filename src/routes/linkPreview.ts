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
import { fetchFollowingSafely } from "../utils/safePreviewFetch";
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
  /** Its presence is how a client knows there is a real player, without
      keeping a list of which sites have one. */
  oembedUrl: string | null;
  /** So a client can tell "no metadata" from "private or gone": a private
      GitHub repo 404s with GitHub's own metadata attached. */
  status: number | null;
}

const cache = new Map<string, { data: LinkPreviewData; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

/** Measured: MDN closes its head at 5.9 KB, YouTube's `og:title` sits at byte
    699,799. The read stops at `</head>`, so this bounds a page that has none. */
const MAX_BYTES = 1_048_576;

const FETCH_TIMEOUT_MS = 8000;

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

async function fetchPreview(url: string): Promise<LinkPreviewData> {
  const empty: LinkPreviewData = { url, ...EMPTY_PAGE_METADATA, status: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    /* A resolver returning null falls through to the ordinary fetch below.
       `status: 200` because the card came from somewhere that answered. */
    const resolver = resolverFor(new URL(url));
    if (resolver) {
      try {
        const resolved = await resolver.resolve(new URL(url), jsonFetcher(controller.signal));
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

// Unref'd, so importing this module does not hold the process open for a
// preview cache sweep. Same as the nonce sweeper in auth/identity.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 2) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();

export const linkPreviewRouter = router;
