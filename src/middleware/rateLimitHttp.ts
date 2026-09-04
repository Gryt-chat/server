/**
 * Rate limiting for the HTTP surface, which had exactly one limit — on the
 * webhook endpoint — while everything else was open. `/api/link-preview` was
 * the worst of them: it fetches a URL the caller chooses from inside this
 * network, an SSRF probe and an outbound amplifier in one endpoint.
 *
 * Reuses `utils/rateLimiter` rather than adding `express-rate-limit`, so there
 * is one place to reason about the window, the ban and the key. It inherits the
 * known limitation: counters live in memory, so a restart clears them.
 */
import type { NextFunction, Request, Response } from "express";

import { resolveClientIp, trustedProxyHops } from "../config/clientAddress";
import { checkRateLimit, type RateLimitRule } from "../utils/rateLimiter";

/**
 * The address to count against. Through `resolveClientIp`, so
 * `GRYT_TRUSTED_PROXY_HOPS` governs it as it governs the socket side — with
 * hops unset behind a proxy every caller collapses into one bucket, which is a
 * misconfiguration to fix rather than work around here.
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

/**
 * Ordinary authenticated API traffic: messages, members.
 *
 * Generous, because a client scrolling history makes a lot of these and a limit
 * that fires while somebody reads their own backlog is worse than no limit.
 * It is here to bound what one address can do, not to pace normal use.
 */
export const RL_HTTP_API: RateLimitRule = { limit: 240, windowMs: 60_000 };

/** Unauthenticated metadata: `/info`, `/icon`, `/health`. */
export const RL_HTTP_PUBLIC: RateLimitRule = { limit: 60, windowMs: 60_000 };
