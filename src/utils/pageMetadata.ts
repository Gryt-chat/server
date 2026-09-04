/**
 * What a page says about itself, read out of its `<head>`.
 *
 * Regex over HTML rather than a parse: only `<meta>` and `<link>` matter and
 * both are flat, so a real parser would mean handing untrusted markup to a
 * dependency for nothing. The regexes handle either attribute order, both
 * quote styles, unquoted values and XHTML's self-closing slash.
 */

export interface PageMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageAlt: string | null;
  siteName: string | null;
  favicon: string | null;
  /** `og:type` — "article", "video.other", "music.song", and so on. */
  type: string | null;
  /** The page's own brand colour, when it declares one. */
  themeColor: string | null;
  /** `<link rel="alternate" type="application/json+oembed">`, if present. */
  oembedUrl: string | null;
  /** `article:author` or the author meta, for the sites that set it. */
  author: string | null;
  /** `article:published_time`, ISO 8601 as the page wrote it. */
  publishedAt: string | null;
}

export const EMPTY_PAGE_METADATA: PageMetadata = {
  title: null,
  description: null,
  image: null,
  imageWidth: null,
  imageHeight: null,
  imageAlt: null,
  siteName: null,
  favicon: null,
  type: null,
  themeColor: null,
  oembedUrl: null,
  author: null,
  publishedAt: null,
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeHtmlEntities(str: string): string {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Surrogates and out-of-range values would throw; the raw text is a
      // better answer than an exception.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

const ATTR_VALUE = "(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))";

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `content` off a `<meta>` whose property/name is `key`, either order. */
export function extractMeta(html: string, key: string): string | null {
  const k = escapeForRegex(key);
  const keyAttr = `(?:property|name|itemprop)\\s*=\\s*(?:"${k}"|'${k}'|${k}(?=[\\s>]))`;
  const patterns = [
    new RegExp(`<meta[^>]*?${keyAttr}[^>]*?content\\s*=\\s*${ATTR_VALUE}`, "i"),
    new RegExp(`<meta[^>]*?content\\s*=\\s*${ATTR_VALUE}[^>]*?${keyAttr}`, "i"),
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    const raw = m?.[1] ?? m?.[2] ?? m?.[3];
    if (raw != null && raw !== "") {
      const decoded = decodeHtmlEntities(raw).trim();
      if (decoded) return decoded;
    }
  }
  return null;
}

function extractTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return null;
  const text = decodeHtmlEntities(m[1].replace(/\s+/g, " ")).trim();
  return text || null;
}

/**
 * `href` off the first `<link>` whose rel is one of `rels`. Tag at a time:
 * matching across tag boundaries takes the rel from one and the href from the
 * next.
 */
function extractLinkHref(html: string, rels: string[]): string | null {
  const tags = html.match(/<link\b[^>]*>/gi);
  if (!tags) return null;
  const wanted = new Set(rels.map((r) => r.toLowerCase()));
  for (const tag of tags) {
    const relMatch = tag.match(new RegExp(`\\brel\\s*=\\s*${ATTR_VALUE}`, "i"));
    const rel = (relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? "").toLowerCase();
    if (!rel) continue;
    // `rel` is a space-separated token list: `rel="shortcut icon"`.
    const tokens = rel.split(/\s+/).filter(Boolean);
    const joined = tokens.join(" ");
    if (!wanted.has(joined) && !tokens.some((t) => wanted.has(t))) continue;
    const hrefMatch = tag.match(new RegExp(`\\bhref\\s*=\\s*${ATTR_VALUE}`, "i"));
    const raw = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
    if (raw) return decodeHtmlEntities(raw).trim();
  }
  return null;
}

function absolute(href: string | null, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function asDimension(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  // A page is free to claim its image is 300000px wide. Nothing downstream
  // wants to reserve that much space, so an absurd value is no value.
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : null;
}

/**
 * The favicon. `apple-touch-icon` first, since it has to be a real raster image
 * at a usable size where `/favicon.ico` is often 16px and sometimes an HTML 404.
 */
function extractFavicon(html: string, baseUrl: string): string | null {
  const href =
    extractLinkHref(html, ["apple-touch-icon", "apple-touch-icon-precomposed"]) ||
    extractLinkHref(html, ["icon", "shortcut icon"]) ||
    extractLinkHref(html, ["mask-icon"]);
  const resolved = absolute(href, baseUrl);
  if (resolved) return resolved;
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}/favicon.ico`;
  } catch {
    return null;
  }
}

/** A colour a page declared, kept only if it is one we can hand to CSS. */
function sanitizeThemeColor(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^rgba?\([\d.\s,%/]+\)$/i.test(v)) return v;
  if (/^hsla?\([\d.\s,%/a-z]+\)$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v.toLowerCase();
  return null;
}

/**
 * The JSON oEmbed endpoint a page advertises. Separate from `extractLinkHref`
 * because the rel is the generic "alternate" and only `type` tells it apart
 * from an RSS feed, so the match needs both attributes on one tag.
 */
function extractOEmbedHref(html: string): string | null {
  const tags = html.match(/<link\b[^>]*>/gi);
  if (!tags) return null;
  for (const tag of tags) {
    if (!/type\s*=\s*["']?application\/json\+oembed/i.test(tag)) continue;
    const m = tag.match(new RegExp(`\\bhref\\s*=\\s*${ATTR_VALUE}`, "i"));
    const raw = m?.[1] ?? m?.[2] ?? m?.[3];
    if (raw) return decodeHtmlEntities(raw).trim();
  }
  return null;
}

export function parsePageMetadata(html: string, baseUrl: string): PageMetadata {
  const title =
    extractMeta(html, "og:title") ||
    extractMeta(html, "twitter:title") ||
    extractTitleTag(html);

  const description =
    extractMeta(html, "og:description") ||
    extractMeta(html, "twitter:description") ||
    extractMeta(html, "description");

  const image = absolute(
    extractMeta(html, "og:image:secure_url") ||
      extractMeta(html, "og:image:url") ||
      extractMeta(html, "og:image") ||
      extractMeta(html, "twitter:image") ||
      extractMeta(html, "twitter:image:src"),
    baseUrl,
  );

  return {
    title,
    description,
    image,
    imageWidth: asDimension(extractMeta(html, "og:image:width")),
    imageHeight: asDimension(extractMeta(html, "og:image:height")),
    imageAlt: extractMeta(html, "og:image:alt") || extractMeta(html, "twitter:image:alt"),
    siteName: extractMeta(html, "og:site_name") || extractMeta(html, "application-name"),
    favicon: extractFavicon(html, baseUrl),
    type: extractMeta(html, "og:type"),
    themeColor: sanitizeThemeColor(extractMeta(html, "theme-color")),
    oembedUrl: absolute(extractOEmbedHref(html), baseUrl),
    author: extractMeta(html, "article:author") || extractMeta(html, "author"),
    publishedAt:
      extractMeta(html, "article:published_time") || extractMeta(html, "datePublished"),
  };
}

/**
 * The charset a response declares. Windows-1252 decoded as UTF-8 turns every
 * curly quote in a title into a replacement character.
 */
export function charsetFromContentType(contentType: string): string {
  const m = contentType.match(/charset\s*=\s*["']?([\w-]+)/i);
  const raw = m?.[1]?.toLowerCase();
  if (!raw) return "utf-8";
  try {
    new TextDecoder(raw);
    return raw;
  } catch {
    return "utf-8";
  }
}
