import type { PageMetadata } from "./pageMetadata";

/**
 * Sites that answer a question the page itself will not (GRYT-913).
 *
 * The ordinary preview reads OpenGraph out of a page's `<head>`, which works
 * for most of the web. It cannot work where the page is never served to us at
 * all: MakerWorld sits behind a Cloudflare managed challenge and answers
 * `403 cf-mitigated: challenge` to anything without a browser, so what the
 * parser gets is 5.8 KB of "Just a moment…" and a card with nothing in it.
 *
 * A resolver is a second way in for one host, chosen by URL rather than tried
 * on everything. Opt-in on purpose: a registry that guessed would spend a
 * request on every dead link to find out it had nothing.
 *
 * **A resolver returns metadata or null. It never throws and never partially
 * fills.** Null means "not my URL, or I could not answer", and the caller falls
 * back to the ordinary fetch — so the worst case here is exactly today's
 * behaviour rather than a broken card.
 */

/** What a resolver knows, which is never the whole of `PageMetadata`. */
export type ResolvedMetadata = Partial<PageMetadata>;

export interface LinkResolver {
  id: string;
  /** Hosts this resolver answers for, matched exactly or as a suffix. */
  hosts: string[];
  /**
   * Whether this URL is one it can do anything with. Cheap and synchronous —
   * a resolver that cannot name the thing being asked about should say so
   * before a request is made rather than after.
   */
  matches: (url: URL) => boolean;
  /**
   * The metadata, or null. `fetchJson` is passed in rather than imported so
   * this module stays free of the network and can be tested without one.
   */
  resolve: (
    url: URL,
    fetchJson: (target: string) => Promise<unknown>,
  ) => Promise<ResolvedMetadata | null>;
}

function hostMatches(hostname: string, hosts: string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * The numeric id out of `/models/1642496-old-vikings-jewelry-box`.
 *
 * The slug is decoration and changes when a model is renamed; the number in
 * front of it is the id their API takes. Locale prefixes vary — `/en/models/…`,
 * `/de/models/…`, and `/models/…` with none — so the segment before `models`
 * is not something to match on.
 */
export function makerWorldModelId(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("models");
  if (at === -1) return null;
  const slug = parts[at + 1];
  if (!slug) return null;
  const id = /^(\d+)(?:-|$)/.exec(slug)?.[1];
  return id ?? null;
}

/**
 * The size and format we want, rather than whatever the upload happened to be.
 *
 * That CDN is Alibaba OSS, so the processing parameters are ours to set, and
 * the difference is not marginal. Measured 2026-09-04 on one cover:
 *
 *     raw                     1.68 MB, content-type application/octet-stream
 *     resize w_640, webp     75.5 KB, content-type image/webp
 *
 * The content type matters as much as the size. A card drawing the raw URL is
 * handing an `<img>` something that does not declare itself an image.
 *
 * Any parameters already on the URL are replaced rather than appended to —
 * two `x-oss-process` values would leave which one wins up to the CDN.
 */
export function withOssResize(rawUrl: string, width = 640): string | null {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("x-oss-process", `image/resize,w_${width}/format,webp`);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Their `summary` is a rich-text blob — `<p>SKOL</p><p>&nbsp;</p>…` — and a
 * card wants one line of prose.
 *
 * Deliberately not a general HTML sanitiser. Everything here is thrown away
 * except text, so there is nothing for a tag to do; `parsePageMetadata` owns
 * the entity decoding that a description from a `<meta>` needs, and this is the
 * small subset that shows up in a WYSIWYG field.
 */
export function summaryToText(html: unknown, max = 300): string | null {
  if (typeof html !== "string") return null;
  const text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * MakerWorld, through the API their own front end uses.
 *
 * `GET /api/v1/design-service/design/{id}` answers 200 with JSON to the
 * ordinary GrytBot user agent — it is not behind the challenge the HTML page
 * is, so nothing here pretends to be a browser.
 *
 * The cover cannot be derived from the model id, which is why this needs a
 * request at all: the path carries the uploader's id and a per-upload date and
 * hash, and neither is a function of the number in the link.
 */
export const makerWorld: LinkResolver = {
  id: "makerworld",
  hosts: ["makerworld.com"],
  matches: (url) => makerWorldModelId(url) !== null,
  async resolve(url, fetchJson) {
    const id = makerWorldModelId(url);
    if (!id) return null;

    const body = await fetchJson(
      `https://makerworld.com/api/v1/design-service/design/${id}`,
    );
    if (!body || typeof body !== "object") return null;

    const design = body as Record<string, unknown>;
    const title = str(design.title);
    const cover = str(design.coverUrl);
    // A response that names neither is not a model — an id that does not exist
    // answers with a shape rather than an error, so this is the check that
    // tells a real one from a miss.
    if (!title && !cover) return null;

    const creator = design.designCreator;
    const author =
      creator && typeof creator === "object"
        ? str((creator as Record<string, unknown>).name)
        : null;

    return {
      title,
      description: summaryToText(design.summary),
      image: cover ? withOssResize(cover) : null,
      siteName: "MakerWorld",
      type: "website",
      author,
      publishedAt: str(design.createTime),
    };
  },
};

const RESOLVERS: LinkResolver[] = [makerWorld];

/** The resolver for this URL, or null if no host claims it. */
export function resolverFor(url: URL): LinkResolver | null {
  for (const resolver of RESOLVERS) {
    if (hostMatches(url.hostname, resolver.hosts) && resolver.matches(url)) {
      return resolver;
    }
  }
  return null;
}
