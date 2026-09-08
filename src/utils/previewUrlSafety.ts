import { lookup } from "node:dns/promises";

import { isPrivateIp } from "./isPrivateIp";

/**
 * A literal private address is caught by the string pass, a hostname resolving
 * to one only by the DNS pass, and neither closes the gap before the request.
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
  /* WHATWG URL keeps the brackets on an IPv6 host; isPrivateIp wants the
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
  return isPrivateIp(stripBrackets(host));
}

/** DNS failure is a refusal: a name that will not resolve was never going to
    produce a preview, so failing closed costs nothing. */
export async function checkPreviewUrl(
  raw: string,
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
  const bare = stripBrackets(parsed.hostname);
  if (isLiteralAddress(bare)) return { ok: true, url: parsed };

  try {
    const addresses = await lookup(parsed.hostname, { all: true });
    if (addresses.length === 0) return { ok: false, reason: "blocked_host" };
    for (const { address } of addresses) {
      if (isPrivateIp(address)) return { ok: false, reason: "blocked_host" };
    }
  } catch {
    return { ok: false, reason: "blocked_host" };
  }

  return { ok: true, url: parsed };
}

function isLiteralAddress(host: string): boolean {
  if (host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
