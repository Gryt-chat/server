import { Router } from "express";
import consola from "consola";

import { requireBearerToken } from "../middleware/requireBearerToken";
import { ensurePermission } from "../middleware/requirePermission";
import { checkPreviewUrl } from "../utils/previewUrlSafety";

type OEmbedOut = {
  html: string;
  providerName: string | null;
  type: string | null;
  width: number | null;
  height: number | null;
  /** The thumbnail an oEmbed response carries, for players drawn as a card. */
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  title: string | null;
  authorName: string | null;
  authorUrl: string | null;
  url: string;
};

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Several providers send dimensions as strings.
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickOEmbedFields(json: unknown, url: string): OEmbedOut | null {
  if (typeof json !== "object" || json === null) return null;
  const rec = json as Record<string, unknown>;
  const html = asString(rec.html);
  if (!html) return null;
  return {
    html,
    providerName: asString(rec.provider_name),
    type: asString(rec.type),
    width: asNumber(rec.width),
    height: asNumber(rec.height),
    thumbnailUrl: asString(rec.thumbnail_url),
    thumbnailWidth: asNumber(rec.thumbnail_width),
    thumbnailHeight: asNumber(rec.thumbnail_height),
    title: asString(rec.title),
    authorName: asString(rec.author_name),
    authorUrl: asString(rec.author_url),
    url,
  };
}

/**
 * The providers worth knowing by name.
 *
 * Everything else is found by discovery below, so this list is not what
 * decides whether a site works — it is the sites where we want a specific
 * parameter set (a theme, a DNT flag, a suppressed script tag) rather than
 * whatever the endpoint does by default.
 */
function getKnownOEmbedEndpoint(url: string, theme?: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "x.com" || host === "twitter.com") {
    const endpoint = new URL("https://publish.twitter.com/oembed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("dnt", "true");
    endpoint.searchParams.set("omit_script", "true");
    if (theme === "dark" || theme === "light") {
      endpoint.searchParams.set("theme", theme);
    }
    return endpoint.toString();
  }

  if (host === "soundcloud.com" || host === "on.soundcloud.com") {
    const endpoint = new URL("https://soundcloud.com/oembed");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("url", url);
    return endpoint.toString();
  }

  if (host === "open.spotify.com") {
    const endpoint = new URL("https://open.spotify.com/oembed");
    endpoint.searchParams.set("url", url);
    return endpoint.toString();
  }

  if (host === "tiktok.com" || host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    const endpoint = new URL("https://www.tiktok.com/oembed");
    endpoint.searchParams.set("url", url);
    return endpoint.toString();
  }

  if (host === "reddit.com" || host === "old.reddit.com") {
    const endpoint = new URL("https://www.reddit.com/oembed");
    endpoint.searchParams.set("url", url);
    return endpoint.toString();
  }

  if (host === "bsky.app") {
    const endpoint = new URL("https://embed.bsky.app/oembed");
    endpoint.searchParams.set("url", url);
    return endpoint.toString();
  }

  return null;
}

const USER_AGENT = "Mozilla/5.0 (compatible; GrytBot/1.0; +https://gryt.chat)";
const FETCH_TIMEOUT_MS = 6000;

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`oembed_fetch_failed_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ask the page itself where its oEmbed endpoint is.
 *
 * A site advertises one with `<link rel="alternate"
 * type="application/json+oembed">`, and hundreds do — Flickr, CodePen, Giphy,
 * Vimeo, Kickstarter, every WordPress install, most Mastodon servers. Reading
 * the tag is what makes those work without adding each one to the list above.
 *
 * The endpoint comes out of a remote document, so it is a URL an attacker
 * controls as surely as the one in the chat box, and it goes through the same
 * check before anything connects to it.
 */
async function discoverOEmbedEndpoint(pageUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const reader = res.body?.getReader();
    if (!reader) return null;

    const decoder = new TextDecoder();
    let html = "";
    let bytesRead = 0;
    // The advertised endpoint lives in the head, same as the OpenGraph tags,
    // so this stops in the same two places for the same reasons.
    const MAX_BYTES = 1_048_576;
    try {
      while (bytesRead < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
        if (html.includes("</head>")) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    const tags = html.match(/<link\b[^>]*>/gi);
    if (!tags) return null;
    for (const tag of tags) {
      if (!/type\s*=\s*["']?application\/json\+oembed/i.test(tag)) continue;
      const m = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
      const raw = (m?.[1] ?? m?.[2] ?? m?.[3])?.replace(/&amp;/g, "&");
      if (!raw) continue;
      try {
        return new URL(raw, res.url || pageUrl).href;
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
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

  const theme = typeof req.query.theme === "string" ? req.query.theme : undefined;

  let endpoint = getKnownOEmbedEndpoint(url, theme);
  if (!endpoint) {
    endpoint = await discoverOEmbedEndpoint(url);
  }
  if (!endpoint) {
    res.status(404).json({ error: "unsupported_url", message: "No oEmbed provider for this URL" });
    return;
  }

  // Discovery returns a URL chosen by the page that was just fetched, so it is
  // checked before it is used rather than trusted for its provenance.
  const checkedEndpoint = await checkPreviewUrl(endpoint);
  if (!checkedEndpoint.ok) {
    res.status(400).json({ error: "blocked_host", message: "Private URLs are not allowed" });
    return;
  }

  try {
    const json = await fetchJsonWithTimeout(endpoint, FETCH_TIMEOUT_MS);
    const out = pickOEmbedFields(json, url);
    if (!out) {
      res.status(502).json({ error: "invalid_oembed", message: "Invalid oEmbed response" });
      return;
    }
    res.json(out);
  } catch (err) {
    consola.warn("oEmbed fetch failed:", { url, endpoint, err });
    res.status(502).json({ error: "fetch_failed", message: "Failed to fetch oEmbed" });
  }
});

export const oEmbedRouter = router;
