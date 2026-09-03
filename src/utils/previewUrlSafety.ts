import { lookup } from "node:dns/promises";

import { isPrivateIp } from "./isPrivateIp";

/**
 * Whether a URL is safe for the server to fetch on a user's behalf.
 *
 * Link previews are the one place Gryt makes an outbound request to an address
 * somebody typed into a chat box, so the server is the attacker's HTTP client
 * unless something says no. Three of these checks look redundant and are not:
 *
 * A literal address (`http://169.254.169.254/`) is caught by the string pass.
 * A hostname that *resolves* to one (`http://metadata.example.com/`, an A
 * record pointing at the same place) is only caught by resolving it, which is
 * why the DNS pass exists at all. And the oEmbed endpoint discovered from a
 * page's `<link rel="alternate">` is a URL the remote page chose, so it goes
 * through the same door as the URL the user pasted rather than being trusted
 * for having come from a site we already fetched.
 *
 * What this does not close is the gap between the check and the request: DNS
 * can answer differently the second time. Closing that means resolving once and
 * connecting to the address rather than the name, which needs a custom agent
 * and is a bigger change than this one.
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

/**
 * Parse and check a URL, resolving the hostname to be sure it does not point
 * somewhere private. Returns the parsed URL, or why it was refused.
 *
 * DNS failure is a refusal rather than a pass. A name that will not resolve was
 * never going to produce a preview, so failing closed costs nothing here.
 */
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
