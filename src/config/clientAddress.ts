/**
 * Which address to hold a client to, and whether it is really theirs.
 *
 * Split out of `src/socket/index.ts` so it can be tested — importing that file
 * starts a server — and because deciding whose address this is turns out to be
 * a security decision rather than bookkeeping.
 */

/**
 * How many proxies in front of this server may be believed.
 *
 * Zero unless an operator says otherwise, and that default is the whole point.
 * `x-forwarded-for` is a header any client can set to anything, so trusting it
 * unconditionally meant every per-IP limit in the server could be walked around
 * by varying one string per connection — measured at 30 joins against a cap of
 * 19, and the same trick defeats the invite brute-force cooldown.
 *
 * **A server behind a proxy must set this**, or every client arrives wearing
 * the proxy's address and shares one rate-limit bucket between them. One for a
 * single reverse proxy or tunnel, more only if you have genuinely chained them.
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
 * The address to hold somebody to, for rate limiting and cooldowns.
 *
 * Counted from the right, which is the only end that means anything.
 * `x-forwarded-for` grows left to right as a request crosses proxies, so the
 * rightmost entries were appended by infrastructure and the leftmost is
 * whatever the client claimed. Reading `[0]` reads the claim.
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
 * Whether the address `resolveClientIp` returned is actually this client's, as
 * opposed to a proxy's, for a decision where being wrong lets somebody in.
 *
 * Rate limiting survives a wrong answer: the worst case is a shared bucket.
 * LAN open join does not. It treats a private address as proof of being on the
 * same network, and behind a proxy every client arrives wearing the proxy's
 * address. Proxies and Docker networks sit on exactly the ranges that check
 * accepts, so a server with the setting on and no hop count configured admits
 * anybody who can reach the proxy, while its own setting reads "anyone on LAN".
 *
 * The signal is whether anything appended to `x-forwarded-for`. A client on a
 * LAN connecting directly has no such header; a request that crossed a proxy
 * does. With a hop count set we read the chain properly and the address is as
 * good as the operator's configuration.
 *
 * A client can set the header on its own request. That only costs it a bypass
 * it would otherwise have been given, and there is no way to use it to gain
 * one.
 */
export function addressIsOwn(
  forwarded: string | string[] | undefined,
  hops: number,
): boolean {
  if (hops > 0) return true;
  return forwardedChain(forwarded).length === 0;
}
