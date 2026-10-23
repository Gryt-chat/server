import consola from "consola";
import { fetch, type Dispatcher } from "undici";

import { checkPreviewUrl, type UrlRejection } from "./previewUrlSafety";
import { isBlockedAddressError, publicOnlyAgent } from "./publicOnlyAgent";

/**
 * Every redirect hop is checked, not just the first: `redirect: "follow"` will
 * land on `http://169.254.169.254/` if the third hop says so.
 */

const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; GrytBot/1.0; +https://gryt.chat)";

export type SafeFetchResult =
  | { res: Response; finalUrl: string }
  | { blocked: true };

type UrlCheck = (raw: string) => Promise<{ ok: true } | { ok: false; reason: UrlRejection }>;

/** Injected so tests can use a local server and a resolver that lies. Production always
    uses the real `checkPreviewUrl` and `publicOnlyAgent`. */
export interface FetchGuard {
  check: UrlCheck;
  dispatcher: Dispatcher;
}

const realGuard: FetchGuard = { check: checkPreviewUrl, dispatcher: publicOnlyAgent };

const DECODABLE = new Set(["", "identity", "gzip", "x-gzip", "deflate"]);

export class RefusedEncodingError extends Error {
  readonly code = "GRYT_REFUSED_ENCODING";
}

/** fetch builds its decoders in onResponseStart, so refusing here means it never decodes a byte.
    Brotli is refused because Node's decoder had a code-execution bug, and Electron can lag the fix. */
const onlyGzipOrDeflate: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) =>
  dispatch(
    opts,
    new Proxy(handler, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (prop !== "onResponseStart") return typeof value === "function" ? value.bind(target) : value;
        return (controller: Dispatcher.DispatchController, status: number, headers: Record<string, string | string[] | undefined>, message?: string) => {
          const codings = [headers["content-encoding"] ?? ""].flat().join(",").toLowerCase().split(",");
          const refused = codings.map((c) => c.trim()).find((c) => !DECODABLE.has(c));
          if (refused !== undefined) {
            controller.abort(new RefusedEncodingError(`refused Content-Encoding ${refused}`));
            return;
          }
          return target.onResponseStart?.(controller, status, headers, message);
        };
      },
    }),
  );

export async function fetchFollowingSafely(
  startUrl: string,
  signal: AbortSignal,
  accept: string,
  guard: FetchGuard = realGuard,
): Promise<SafeFetchResult> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await guard.check(current);
    if (!checked.ok) return { blocked: true };

    let res: Response;
    try {
      // undici types the body as ReadableStream<any>. The chunks are Uint8Array, as the DOM type says.
      res = (await fetch(current, {
        signal,
        redirect: "manual",
        dispatcher: guard.dispatcher.compose(onlyGzipOrDeflate),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          "Accept-Encoding": "gzip, deflate",
          "Accept-Language": "en;q=0.9,*;q=0.5",
        },
      })) as unknown as Response;
    } catch (err) {
      // A name that passed the check can answer differently when the connection asks.
      if (isBlockedAddressError(err)) return { blocked: true };
      throw err;
    }

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
