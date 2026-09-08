/**
 * Reuses `utils/rateLimiter` rather than adding `express-rate-limit`, so there is
 * one place to reason about the window, the ban and the key — and one
 * limitation: counters live in memory, so a restart clears them.
 */
import type { NextFunction, Request, Response } from "express";

import { resolveClientIp, trustedProxyHops } from "../config/clientAddress";
import { checkRateLimit, type RateLimitRule } from "../utils/rateLimiter";

/** Through `resolveClientIp`, so `GRYT_TRUSTED_PROXY_HOPS` governs it: unset
    behind a proxy, every caller collapses into one bucket. */
export function requestIp(req: Request): string {
  return resolveClientIp(
    req.socket?.remoteAddress || "",
    req.headers["x-forwarded-for"],
    trustedProxyHops(),
  );
}

/** Keyed on address rather than identity: most of these routes are reachable
    without a token, and checking a signature is itself work worth bounding. */
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

/** The tightest of these: each call turns one cheap request into an outbound one
    from inside the network. */
export const RL_HTTP_OUTBOUND: RateLimitRule = { limit: 20, windowMs: 60_000, banMs: 60_000 };

/** Writing bytes to disk, which costs storage rather than only time. */
export const RL_HTTP_UPLOAD: RateLimitRule = { limit: 30, windowMs: 60_000, banMs: 30_000 };

/**
 * An import is one gesture that becomes a request per emoji. No `banMs`: this
 * burst is somebody using it as intended, and the ban is what took the emoji
 * list down with the writes while the mount had one bucket.
 */
export const RL_HTTP_EMOJI_WRITE: RateLimitRule = { limit: 150, windowMs: 60_000 };

/** Generous, because a busy channel fetches many files as it scrolls and a limit
    that fires while somebody reads their own history is worse than none. */
export const RL_HTTP_FILE: RateLimitRule = { limit: 240, windowMs: 60_000 };

/** Generous: this bounds what one address can do rather than pacing normal use,
    and a client scrolling history makes a lot of these. */
export const RL_HTTP_API: RateLimitRule = { limit: 240, windowMs: 60_000 };

/** Unauthenticated metadata: `/info`, `/icon`, `/health`. */
export const RL_HTTP_PUBLIC: RateLimitRule = { limit: 60, windowMs: 60_000 };
