/** Split out of `src/socket/index.ts` so it can be tested; importing that starts
    a server. */

/** Zero by default, because `x-forwarded-for` is a header any client can set. A
    server behind a proxy must set this or every client shares one bucket. */
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

/** Counted from the right: `x-forwarded-for` grows left to right, so `[0]` is
    whatever the client claimed. */
export function resolveClientIp(
  socketAddress: string,
  forwarded: string | string[] | undefined,
  hops: number,
): string {
  if (hops === 0) return socketAddress;

  const chain = forwardedChain(forwarded);
  // Asking for more hops than the chain holds means the request did not come
  // through them, so believe the socket.
  const index = chain.length - hops;
  return index >= 0 && index < chain.length ? chain[index] : socketAddress;
}

/** For LAN open join, which reads a private address as proof of being on the
    network — and proxies sit on exactly those ranges. */
export function addressIsOwn(
  forwarded: string | string[] | undefined,
  hops: number,
): boolean {
  if (hops > 0) return true;
  return forwardedChain(forwarded).length === 0;
}
