/**
 * Importing emojis from emoji.gg. Same shape as the BetterTTV routes next door,
 * except this reads HTML: the JSON API returns about 5,400 emojis, a slice of
 * the site, and none of the ones this was built for are in it.
 *
 * Three page shapes, three parsers, because the markup differs:
 *
 *   /user/<name>   lazy-loaded, URL in data-src, name in alt as "<Name> Emoji"
 *   /pack/<slug>   alt is literally "Emoji", so the name comes from the
 *                  filename; each image is paired with the /emoji/ link
 *                  wrapping it, so related-pack thumbnails drop out
 *   /emoji/<slug>  og:image is the file, og:title is the name
 *
 * All three break when emoji.gg redesigns. They fail by returning nothing
 * rather than something wrong.
 */
import type { Router, Request, Response, NextFunction } from "express";

import { DEFAULT_EMOJI_MAX_BYTES, getServerConfig } from "../db";

const BASE = "https://emoji.gg";

// Without this emoji.gg answers requests from a bare fetch with a challenge
// page rather than the listing.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/**
 * A profile with 225 emojis is nine requests. The cap is what stops a profile
 * with thousands from turning one click into a few hundred, and the client is
 * told when it bites rather than being handed a quietly short list.
 */
const MAX_USER_PAGES = 40;
const PAGE_DELAY_MS = 250;

/** What emoji.gg allows in a slug, and so in a CDN filename. */
const SLUG_RE = /^[A-Za-z0-9_-]{1,100}$/;
const USERNAME_RE = /^[^/?#]{1,64}$/;

/**
 * The only URLs the file proxy will fetch. Anchored, no query string, no dots
 * beyond the extension — the proxy exists because the client cannot read these
 * cross-origin, not to be a general fetcher.
 */
const CDN_FILE_RE =
  /^https:\/\/cdn\d*\.emoji\.gg\/emojis\/[A-Za-z0-9_-]+\.(png|gif|webp|jpe?g|avif)$/;

// These are written without named groups, the `s` flag or matchAll: this
// package targets ES2016, and bumping the whole server's target to please one
// route is not a change that belongs in it. [\s\S] is the `s` flag by hand.

/** Cards on a profile: CDN URL in data-src (1), display name in alt (2). */
const USER_CARD_RE =
  /data-src="(https:\/\/cdn\d*\.emoji\.gg\/emojis\/[^"]+)"[^>]*?\salt="([^"]*)"/g;

/** Pack entries: an /emoji/ link, then the image it wraps (1). */
const PACK_ENTRY_RE =
  /href="https:\/\/emoji\.gg\/emoji\/[^"]+"[\s\S]*?<img[^>]*?src="(https:\/\/cdn\d*\.emoji\.gg\/emojis\/[^"]+)"/g;

const OG_IMAGE_RE =
  /<meta\s+property="og:image"\s+content="(https:\/\/cdn\d*\.emoji\.gg\/emojis\/[^"]+)"/;
const OG_TITLE_RE = /<meta\s+property="og:title"\s+content="([^"]*)"/;

/** The profile's own count, used to stop paging without an extra empty request. */
const USER_COUNT_RE = /Emojis\s*<span[^>]*>\s*([\d,]+)\s*<\/span>/;

export interface EmojiGgEmote {
  /** The emoji.gg slug, which is also the CDN filename without its extension. */
  id: string;
  /** What it is called on emoji.gg, before Gryt's naming rules are applied. */
  code: string;
  imageType: string;
  animated: boolean;
  url: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

async function fetchPage(url: string): Promise<string | null> {
  const resp = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!resp.ok) return null;
  return resp.text();
}

function fileFromUrl(url: string): { slug: string; ext: string } | null {
  const filename = url.split("/").pop()?.split("?")[0];
  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  const slug = filename.slice(0, dot);
  const ext = filename.slice(dot + 1).toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  return { slug, ext };
}

/**
 * A CDN URL to an emote. The name comes from alt, or from the filename, which
 * is `<id><-|_><name>.<ext>`. Null rather than a guessed name.
 */
function toEmote(url: string, altName: string | null): EmojiGgEmote | null {
  const parsed = fileFromUrl(url);
  if (!parsed) return null;

  const fromAlt = altName ? decodeEntities(altName).replace(/\s+Emoji$/i, "").trim() : "";
  const fromFile = parsed.slug.replace(/^\d+[-_]+/, "") || parsed.slug;

  return {
    id: parsed.slug,
    code: fromAlt || fromFile,
    imageType: parsed.ext,
    animated: parsed.ext === "gif",
    url,
  };
}

function parseAll(
  html: string,
  pattern: RegExp,
  altIndex: number | null,
): EmojiGgEmote[] {
  const found: EmojiGgEmote[] = [];
  // Fresh lastIndex per call: these are module-level and /g is stateful.
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(html);
  while (match !== null) {
    const emote = toEmote(
      decodeEntities(match[1]),
      altIndex === null ? null : (match[altIndex] ?? null),
    );
    if (emote) found.push(emote);
    match = pattern.exec(html);
  }
  return found;
}

function parseUserPage(html: string): EmojiGgEmote[] {
  return parseAll(html, USER_CARD_RE, 2);
}

function parsePackPage(html: string): EmojiGgEmote[] {
  return parseAll(html, PACK_ENTRY_RE, null);
}

function dedupe(emotes: EmojiGgEmote[]): EmojiGgEmote[] {
  const seen = new Set<string>();
  return emotes.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

export function registerEmojiGgRoutes(router: Router): void {
  router.get(
    "/emojigg/user/:username",
    (req: Request, res: Response, next: NextFunction): void => {
      const username = String(req.params.username);
      if (!USERNAME_RE.test(username)) {
        res.status(400).json({ error: "invalid_username" });
        return;
      }

      Promise.resolve()
        .then(async () => {
          const collected: EmojiGgEmote[] = [];
          const seen = new Set<string>();
          let expected: number | null = null;
          let truncated = false;
          let page = 0;

          for (; page < MAX_USER_PAGES; page++) {
            const html = await fetchPage(
              `${BASE}/user/${encodeURIComponent(username)}?page=${page}&sort=recent`,
            );
            if (html === null) {
              if (page === 0) {
                res.status(404).json({
                  error: "not_found",
                  message: "emoji.gg did not return that profile.",
                });
                return;
              }
              break;
            }

            if (expected === null) {
              const count = USER_COUNT_RE.exec(html);
              if (count) expected = Number(count[1].replace(/,/g, ""));
            }

            const fresh = parseUserPage(html).filter((e) => !seen.has(e.id));
            for (const emote of fresh) {
              seen.add(emote.id);
              collected.push(emote);
            }

            // A page with nothing new on it is the end of the profile — or a
            // redesign, which looks the same from here and stops just as well.
            if (fresh.length === 0) break;
            if (expected !== null && collected.length >= expected) break;
            if (page + 1 >= MAX_USER_PAGES) truncated = true;

            await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
          }

          res.json({
            title: username,
            total: expected,
            truncated,
            emotes: collected,
          });
        })
        .catch(next);
    },
  );

  router.get(
    "/emojigg/pack/:slug",
    (req: Request, res: Response, next: NextFunction): void => {
      const slug = String(req.params.slug);
      if (!SLUG_RE.test(slug)) {
        res.status(400).json({ error: "invalid_slug" });
        return;
      }

      Promise.resolve()
        .then(async () => {
          const html = await fetchPage(`${BASE}/pack/${slug}`);
          if (html === null) {
            res.status(404).json({ error: "not_found", message: "emoji.gg did not return that pack." });
            return;
          }

          const title = OG_TITLE_RE.exec(html)?.[1];
          res.json({
            title: title ? decodeEntities(title).replace(/\s*-\s*Emoji Pack$/i, "") : slug,
            total: null,
            truncated: false,
            emotes: dedupe(parsePackPage(html)),
          });
        })
        .catch(next);
    },
  );

  router.get(
    "/emojigg/emoji/:slug",
    (req: Request, res: Response, next: NextFunction): void => {
      const slug = String(req.params.slug);
      if (!SLUG_RE.test(slug)) {
        res.status(400).json({ error: "invalid_slug" });
        return;
      }

      Promise.resolve()
        .then(async () => {
          const html = await fetchPage(`${BASE}/emoji/${slug}`);
          if (html === null) {
            res.status(404).json({ error: "not_found", message: "emoji.gg did not return that emoji." });
            return;
          }

          const url = OG_IMAGE_RE.exec(html)?.[1];
          const emote = url ? toEmote(decodeEntities(url), null) : null;
          if (!emote) {
            res.status(502).json({
              error: "parse_failed",
              message: "Could not find the emoji file on that page.",
            });
            return;
          }

          const title = OG_TITLE_RE.exec(html)?.[1];
          if (title) {
            const cleaned = decodeEntities(title).replace(/\s*-\s*Discord Emoji$/i, "").trim();
            if (cleaned) emote.code = cleaned;
          }

          res.json({ title: emote.code, total: 1, truncated: false, emotes: [emote] });
        })
        .catch(next);
    },
  );

  router.get(
    "/emojigg/file",
    (req: Request, res: Response, next: NextFunction): void => {
      const url = typeof req.query.url === "string" ? req.query.url : "";
      if (!CDN_FILE_RE.test(url)) {
        res.status(400).json({ error: "invalid_url" });
        return;
      }

      Promise.resolve()
        .then(async () => {
          const cfg = await getServerConfig().catch(() => null);
          const maxEmojiBytes = cfg?.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES;

          const cdnResp = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
          if (!cdnResp.ok) {
            res.status(cdnResp.status).json({
              error: "emojigg_cdn_fetch_failed",
              message: `CDN returned ${cdnResp.status}`,
            });
            return;
          }

          const bytes = Buffer.from(await cdnResp.arrayBuffer());
          if (bytes.length > maxEmojiBytes) {
            res.status(413).json({
              error: "emoji_too_large",
              message: `Emoji is larger than max allowed (${maxEmojiBytes} bytes).`,
              bytes: bytes.length,
              maxBytes: maxEmojiBytes,
            });
            return;
          }

          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Length", String(bytes.length));
          res.setHeader(
            "Content-Type",
            cdnResp.headers.get("content-type") ?? "application/octet-stream",
          );
          res.end(bytes);
        })
        .catch(next);
    },
  );
}
