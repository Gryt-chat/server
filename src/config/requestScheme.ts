export type Scheme = "http" | "https";

/** Behind trusted proxies the socket belongs to the last proxy, so x-forwarded-proto says what
    the client dialled. Read from the right like x-forwarded-for; only http and https count. */
export function resolveScheme(
  socketEncrypted: boolean,
  forwardedProto: string | string[] | undefined,
  hops: number,
): Scheme {
  const own: Scheme = socketEncrypted ? "https" : "http";
  if (hops === 0) return own;

  const chain = (Array.isArray(forwardedProto) ? forwardedProto.join(",") : forwardedProto || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (chain.length === 0) return own;

  // Most proxies overwrite the header rather than append, so a short chain is still theirs.
  const claim = chain[Math.max(0, chain.length - hops)];
  return claim === "https" || claim === "http" ? claim : own;
}
