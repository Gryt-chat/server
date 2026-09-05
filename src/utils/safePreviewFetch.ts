import consola from "consola";

import { checkPreviewUrl, type UrlRejection } from "./previewUrlSafety";

/**
 * Fetch a URL on a user's behalf, checking every redirect hop rather than only
 * the one that was asked for.
 *
 * `redirect: "follow"` hands the whole chain to undici, which will happily land
 * on `http://169.254.169.254/` if that is where the third hop points — the
 * guard ran once, on the first URL, and saw none of the rest. Following by hand
 * costs a loop and means `checkPreviewUrl` applies to the address actually
 * connected to.
 *
 * This lived inside `routes/linkPreview.ts`. It is out here because it is the
 * one safe way for this server to fetch a URL somebody typed into chat, and the
 * oEmbed route needs the same thing — a second copy is how one of them ends up
 * following redirects again.
 *
 * The caller owns the body: on `{ res }` it must read or cancel it, the same as
 * any `fetch`. On `{ blocked: true }` there is nothing to clean up.
 */

const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; GrytBot/1.0; +https://gryt.chat)";

export type SafeFetchResult =
  | { res: Response; finalUrl: string }
  | { blocked: true };

/**
 * The address check, injected so the redirect re-check can be tested without a
 * public host to redirect *from* — the same reason `linkResolvers` takes its
 * `fetchJson`. Production always uses the real `checkPreviewUrl`.
 */
type UrlCheck = (raw: string) => Promise<{ ok: true } | { ok: false; reason: UrlRejection }>;

export async function fetchFollowingSafely(
  startUrl: string,
  signal: AbortSignal,
  accept: string,
  check: UrlCheck = checkPreviewUrl,
): Promise<SafeFetchResult> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await check(current);
    if (!checked.ok) return { blocked: true };

    const res = await fetch(current, {
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
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

  // More than MAX_REDIRECTS hops. A real page does not need them, and a chain
  // this long is usually something trying to get somewhere it was refused.
  consola.debug("preview fetch exceeded redirect budget", { startUrl });
  return { blocked: true };
}
