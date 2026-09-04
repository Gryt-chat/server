/**
 * Which address to hold a client to, and whether it is really theirs. Split out
 * of `src/socket/index.ts` so it can be tested; importing that starts a server.
 */

/**
 * How many proxies in front of this server may be believed. Zero by default:
 * `x-forwarded-for` is a header any client can set, so trusting it walks around
 * every per-IP limit by varying one string per connection.
 *
 * **A server behind a proxy must set this**, or every client arrives wearing
 * the proxy's address and shares one rate-limit bucket.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.GRYT_TRUSTED_PROXY_HOPS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** The x-forwarded-for chain, left to right, oldest claim first. */
function forwardedChain(header: string | string[] | undefined): string[] {
  return (Array.isArray(header) ? header.join(",") : header || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The address to hold somebody to. Counted from the right: `x-forwarded-for`
 * grows left to right, so the leftmost entry is whatever the client claimed and
 * reading `[0]` reads the claim.
 */
export function resolveClientIp(
  socketAddress: string,
  forwarded: string | string[] | undefined,
  hops: number,
): string {
  if (hops === 0) return socketAddress;

  const chain = forwardedChain(forwarded);
  // One hop means the last entry was written by our own proxy about its peer.
  // Asking for more hops than the chain holds means the request did not come
  // through them, so believe the socket rather than the shortfall.
  const index = chain.length - hops;
  return index >= 0 && index < chain.length ? chain[index] : socketAddress;
}

/**
 * Whether that address is actually this client's rather than a proxy's, for a
 * decision where being wrong lets somebody in.
 *
 * Rate limiting survives a wrong answer; LAN open join does not. It treats a
 * private address as proof of being on the same network, and proxies and Docker
 * networks sit on exactly those ranges — so with no hop count configured, a
 * server reading "anyone on LAN" admits anybody who can reach the proxy.
 *
 * The signal is whether anything appended to `x-forwarded-for`. A client can
 * set it on its own request, which only costs it a bypass it would have had.
 */
export function addressIsOwn(
  forwarded: string | string[] | undefined,
  hops: number,
): boolean {
  if (hops > 0) return true;
  return forwardedChain(forwarded).length === 0;
}
