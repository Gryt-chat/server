/**
 * Rate limiting for the HTTP surface.
 *
 * Socket events have been limited for a long time — 24 call sites, sliding
 * window plus a decaying score. HTTP had exactly one limit, on the webhook
 * endpoint, and everything else was open: uploads, avatars, the server icon,
 * emoji and its bulk importers, link previews, oEmbed, media metadata, file
 * serving, `/info`, `/icon` and `/metrics`.
 *
 * `/api/link-preview` was the worst of them. It fetches a URL the caller
 * chooses, from inside this network, with no limit at all — an SSRF probe and
 * an outbound amplifier in the same endpoint.
 *
 * This deliberately reuses `utils/rateLimiter` rather than adding
 * `express-rate-limit`. One implementation means one place to reason about the
 * window, the ban and the key, and the socket side already had to solve all
 * three. It also inherits the known limitation: counters live in memory, so a
 * restart clears them.
 */
import type { NextFunction, Request, Response } from "express";

import { resolveClientIp, trustedProxyHops } from "../config/clientAddress";
import { checkRateLimit, type RateLimitRule } from "../utils/rateLimiter";

/**
 * The address to count against.
 *
 * Goes through `resolveClientIp` rather than reading `x-forwarded-for`
 * directly, so `GRYT_TRUSTED_PROXY_HOPS` governs it exactly as it governs the
 * socket side. Behind a proxy with hops unset, every caller collapses into one
 * bucket and the first heavy user rate-limits everybody — which is a
 * misconfiguration to fix rather than something to work around here.
 */
export function requestIp(req: Request): string {
  return resolveClientIp(
    req.socket?.remoteAddress || "",
    req.headers["x-forwarded-for"],
    trustedProxyHops(),
  );
}

/**
 * Limit an HTTP route by client address.
 *
 * Keyed on address alone rather than on an identity: most of these routes are
 * reachable without a token, and the ones that are not are still worth limiting
 * before authentication runs, since parsing a body and checking a signature is
 * work an unauthenticated caller should not be able to demand without bound.
 */
export function httpRateLimit(event: string, rule: RateLimitRule) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = checkRateLimit(event, undefined, requestIp(req), rule);
    if (result.allowed) {
      next();
      return;
    }

    const retryAfterMs = result.retryAfterMs || 0;
    // Seconds, rounded up and never zero: a Retry-After of 0 invites an
    // immediate retry, which is the thing being asked not to happen.
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    res.status(429).json({
      error: "rate_limited",
      message: "Too many requests. Try again shortly.",
      retryAfterMs,
    });
  };
}

/**
 * Routes that make this server fetch a URL somebody else chose.
 *
 * The tightest of these on purpose. Each call turns one cheap request into an
 * outbound one from inside the network, so this is the endpoint an attacker
 * uses to probe what is reachable from here, or to point our bandwidth at
 * somebody else.
 */
export const RL_HTTP_OUTBOUND: RateLimitRule = { limit: 20, windowMs: 60_000, banMs: 60_000 };

/** Writing bytes to disk, which costs storage rather than only time. */
export const RL_HTTP_UPLOAD: RateLimitRule = { limit: 30, windowMs: 60_000, banMs: 30_000 };

/**
 * Reading an attachment back.
 *
 * Generous, because a busy channel legitimately fetches many files as it
 * scrolls, and a limit that fires while somebody reads their own history is
 * worse than no limit at all.
 */
export const RL_HTTP_FILE: RateLimitRule = { limit: 240, windowMs: 60_000 };

/** Unauthenticated metadata: `/info`, `/icon`, `/health`. */
export const RL_HTTP_PUBLIC: RateLimitRule = { limit: 60, windowMs: 60_000 };

/**
 * `/metrics`.
 *
 * Nothing legitimate scrapes it more than once or twice a minute, and it is the
 * most detailed thing this server will tell a stranger. Requiring
 * authentication on it is a separate change; this bounds it in the meantime.
 */
export const RL_HTTP_METRICS: RateLimitRule = { limit: 12, windowMs: 60_000 };
