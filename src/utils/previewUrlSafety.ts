import { isIP } from "node:net";

import { isPublicAddress } from "./publicAddress";
import { systemResolve, type Resolve } from "./publicOnlyAgent";

/**
 * An early refusal the routes can give a reason for. The fetch looks the name up again,
 * so the part that holds is `publicOnlyAgent`, which checks the address it connects to.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "[::]",
  "[::1]",
  /* Cloud instance metadata, which answers on a link-local address but is
     reached by name often enough to be worth naming. */
  "metadata.google.internal",
  "instance-data",
]);

export type UrlRejection = "invalid_url" | "blocked_host";

function stripBrackets(hostname: string): string {
  /* WHATWG URL keeps the brackets on an IPv6 host; isIP wants the
     address on its own. */
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** The string-only pass. Cheap, synchronous, and catches a literal address. */
export function isBlockedPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  /* `.localhost` is reserved and resolves to the loopback by convention;
     `.internal` is what the cloud providers hand out inside a VPC. */
  if (host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  const bare = stripBrackets(host);
  return isIP(bare) !== 0 && !isPublicAddress(bare);
}

/** DNS failure is a refusal: a name that will not resolve was never going to
    produce a preview, so failing closed costs nothing. */
export async function checkPreviewUrl(
  raw: string,
  resolve: Resolve = systemResolve,
): Promise<{ ok: true; url: URL } | { ok: false; reason: UrlRejection }> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "invalid_url" };
  }
  if (isBlockedPreviewHost(parsed.hostname)) {
    return { ok: false, reason: "blocked_host" };
  }

  /* A literal address has already been checked above and has nothing to look
     up, so asking DNS about it would only be a way to fail. */
  if (isIP(stripBrackets(parsed.hostname)) !== 0) return { ok: true, url: parsed };

  try {
    const addresses = await resolve(parsed.hostname, {});
    if (addresses.length === 0) return { ok: false, reason: "blocked_host" };
    for (const { address } of addresses) {
      if (!isPublicAddress(address)) return { ok: false, reason: "blocked_host" };
    }
  } catch {
    return { ok: false, reason: "blocked_host" };
  }

  return { ok: true, url: parsed };
}
