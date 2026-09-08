/** Split out of `index.ts` so it can be tested; importing that starts a
    server. */

/** 3666 is the Vite dev port, and origins are matched exactly, so both
    spellings of loopback are listed. Outside production only. */
export const DEV_CORS_ORIGINS = ["http://localhost:3666", "http://127.0.0.1:3666"];

export const DEFAULT_CORS_ORIGINS =
  "http://127.0.0.1:15738,https://app.gryt.chat,https://beta.gryt.chat";

export function readAllowedOrigins(
  raw: string | undefined,
  isProduction: boolean,
): string[] {
  return (raw || DEFAULT_CORS_ORIGINS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(isProduction ? [] : DEV_CORS_ORIGINS);
}

/** Whether `origin` is http(s) at exactly `host`, port included. */
export function originIsHost(origin: string, host: string): boolean {
  if (!host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // `url.host` keeps the port, which matters: a server on :5001 must not
    // accept an origin at :5002 on the same machine.
    return url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** `requestHost` is what lets a native app in: the phone's WebSocket sets
    `Origin` to the server itself. The exact host, never a suffix match. */
export function isOriginAllowed(
  origin: string,
  allowed: string[],
  requestHost?: string,
): boolean {
  if (allowed.includes("*")) return true;
  if (origin === "null") return true;
  if (allowed.includes(origin)) return true;
  return requestHost !== undefined && originIsHost(origin, requestHost);
}
