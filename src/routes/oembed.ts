import { Router } from "express";
import consola from "consola";

import { requireBearerToken } from "../middleware/requireBearerToken";

type OEmbedOut = {
  html: string;
  providerName: string | null;
  type: string | null;
  width: number | null;
  height: number | null;
  url: string;
};

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "[::1]",
]);

function isBlockedHost(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (/^(127|10|192\.168)\.\d/.test(hostname)) return true;
  if (hostname.startsWith("172.") && /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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
    url,
  };
}

function getOEmbedEndpoint(url: string): string | null {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "x.com" || host === "twitter.com") {
    const endpoint = new URL("https://publish.twitter.com/oembed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("dnt", "true");
    endpoint.searchParams.set("omit_script", "true");
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

  return null;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; GrytBot/1.0; +https://gryt.chat)",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`oembed_fetch_failed_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

const router = Router();

router.get("/", requireBearerToken, async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) {
    res.status(400).json({ error: "missing_url", message: "URL parameter is required" });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: "invalid_url", message: "Invalid URL" });
    return;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    res.status(400).json({ error: "invalid_url", message: "Only HTTP/HTTPS URLs are supported" });
    return;
  }
  if (isBlockedHost(parsed.hostname)) {
    res.status(400).json({ error: "invalid_url", message: "Private URLs are not allowed" });
    return;
  }

  const endpoint = getOEmbedEndpoint(url);
  if (!endpoint) {
    res.status(400).json({ error: "unsupported_url", message: "No oEmbed provider for this URL" });
    return;
  }

  try {
    const json = await fetchJsonWithTimeout(endpoint, 6000);
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

