import type { PageMetadata } from "./pageMetadata";

/**
 * A second way in for one host, for pages never served to us — MakerWorld
 * answers a challenge page. Returns metadata or null, never throws.
 */

/** What a resolver knows, which is never the whole of `PageMetadata`. */
export type ResolvedMetadata = Partial<PageMetadata>;

export interface LinkResolver {
  id: string;
  /** Hosts this resolver answers for, matched exactly or as a suffix. */
  hosts: string[];
  /** Cheap and synchronous: a resolver that cannot name the thing being asked
      about should say so before a request is made. */
  matches: (url: URL) => boolean;
  /** `fetchJson` is passed in rather than imported, so this module stays free
      of the network and tests without one. */
  resolve: (
    url: URL,
    fetchJson: (target: string) => Promise<unknown>,
  ) => Promise<ResolvedMetadata | null>;
}

function hostMatches(hostname: string, hosts: string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The slug changes when a model is renamed; the number in front of it is the
    id. Locale prefixes vary, so the segment before `models` is not matchable. */
export function makerWorldModelId(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("models");
  if (at === -1) return null;
  const slug = parts[at + 1];
  if (!slug) return null;
  const id = /^(\d+)(?:-|$)/.exec(slug)?.[1];
  return id ?? null;
}

/** Measured on one cover: 1.68 MB of application/octet-stream raw against
    75.5 KB of image/webp resized. Existing parameters are replaced, not added. */
export function withOssResize(rawUrl: string, width = 640): string | null {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("x-oss-process", `image/resize,w_${width}/format,webp`);
    return url.toString();
  } catch {
    return null;
  }
}

/** Not a general sanitiser: everything but text is thrown away, so a tag has
    nothing to do. `parsePageMetadata` owns the full entity decoding. */
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

/** Their design API answers the ordinary GrytBot agent, so nothing here pretends
    to be a browser. The request is needed because the cover path is not derivable. */
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
    // An id that does not exist answers with a shape rather than an error, so
    // naming neither is how a miss is told from a model.
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
