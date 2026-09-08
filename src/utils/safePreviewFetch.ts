import consola from "consola";

import { checkPreviewUrl, type UrlRejection } from "./previewUrlSafety";

/**
 * Every redirect hop is checked, not just the first: `redirect: "follow"` will
 * land on `http://169.254.169.254/` if the third hop says so.
 */

const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; GrytBot/1.0; +https://gryt.chat)";

export type SafeFetchResult =
  | { res: Response; finalUrl: string }
  | { blocked: true };

/** Injected so the redirect re-check tests without a public host to redirect
    from. Production always uses the real `checkPreviewUrl`. */
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
