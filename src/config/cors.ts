/**
 * Who is allowed to open a connection to this server.
 *
 * Split out of `index.ts` so it can be tested — importing that file starts a
 * server — and because this is the kind of decision that should be readable on
 * its own.
 */

/**
 * 3666 is the Vite dev port (packages/client/vite.config.ts). Origins are
 * matched exactly, so both spellings of loopback have to be listed. Added
 * outside production only — a production server has no reason to accept an
 * origin it can't reach. ops/start_dev.sh passes these explicitly too; this is
 * for servers started by hand, which otherwise reject the dev client with a
 * bare 400 on the socket.io handshake.
 */
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

/**
 * Electron production builds load from http://127.0.0.1:15738 or send
 * `Origin: "null"` (file://).
 *
 * `requestHost` is what lets a native app in. React Native's WebSocket sets
 * `Origin` from the URL it opens, so the phone arrives claiming the server
 * itself — which is same-origin, and not what CORS was ever about.
 *
 * **The exact host, never a wildcard or a suffix match**: `chat.example.com`
 * does not speak for `evil.example`, and a different port is a different origin.
 */
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
