import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { Agent, buildConnector } from "undici";

import { isPublicAddress } from "./publicAddress";

/** `dns.lookup` with `all: true`, swappable so a test can answer differently each time. */
export type Resolve = (
  hostname: string,
  options: { family?: number | "IPv4" | "IPv6"; hints?: number },
) => Promise<LookupAddress[]>;

export const systemResolve: Resolve = (hostname, options) => lookup(hostname, { ...options, all: true });

export class BlockedAddressError extends Error {
  readonly code = "GRYT_BLOCKED_ADDRESS";
  readonly hostname: string;
  readonly address: string;

  constructor(hostname: string, address: string) {
    super(address ? `refused ${address} for ${hostname}: not a public address` : `refused ${hostname}: no address`);
    this.name = "BlockedAddressError";
    this.hostname = hostname;
    this.address = address;
  }
}

/** fetch wraps a connection error as `TypeError: fetch failed`, with the reason on `cause`. */
export function isBlockedAddressError(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    if (e instanceof BlockedAddressError) return true;
  }
  return false;
}

/** Every answer has to pass, and `net` connects to the answers handed back here without
    asking DNS again. That is what pins the connection to the address that was checked. */
function pinnedLookup(resolve: Resolve, allow: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { family: options.family, hints: options.hints }).then(
      (addresses) => {
        const refused = addresses.find((a) => !allow(a.address));
        if (refused || addresses.length === 0) {
          callback(new BlockedAddressError(hostname, refused?.address ?? ""), "");
        } else if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}

export interface PublicOnlyOptions {
  resolve?: Resolve;
  allow?: (address: string) => boolean;
}

export function createPublicOnlyAgent({ resolve = systemResolve, allow = isPublicAddress }: PublicOnlyOptions = {}): Agent {
  // HTTP/1.1 only, which is what Node's own fetch offers. undici 8 would offer h2 as well.
  const connect = buildConnector({ lookup: pinnedLookup(resolve, allow), allowH2: false });
  return new Agent({
    allowH2: false,
    connect(options, callback) {
      // `net` skips `lookup` for a literal address, so a literal is checked here instead.
      const host = options.hostname.replace(/^\[(.*)\]$/, "$1");
      if (isIP(host) !== 0 && !allow(host)) {
        callback(new BlockedAddressError(host, host), null);
        return;
      }
      connect(options, callback);
    },
  });
}

/** Shared, so connections to the same origin are reused. Every new one is checked. */
export const publicOnlyAgent = createPublicOnlyAgent();
