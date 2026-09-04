import { createHash, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Guards the management endpoint. Two things protect it: this token covers
 * other users and processes on the same host, and the Compose file publishing
 * the port to 127.0.0.1 covers everybody else.
 *
 * **Deliberately no check on the peer address.** A container cannot see one —
 * measured 2026-08-20, a request from the host's own loopback arrives from
 * 192.168.215.1, the Docker bridge gateway. A `req.ip === "127.0.0.1"` guard
 * would reject every legitimate request while proving nothing, which is worse
 * than no guard because it reads like one.
 *
 * The listener does not start unless GRYT_ADMIN_TOKEN is set.
 */
export function adminTokenConfigured(): boolean {
  return (process.env.GRYT_ADMIN_TOKEN || "").trim().length > 0;
}

export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const expected = (process.env.GRYT_ADMIN_TOKEN || "").trim();
  if (!expected) {
    // Should be unreachable: the listener is not started without a token.
    res.status(503).json({ error: "management_disabled", message: "Management is not enabled on this server." });
    return;
  }

  const header = req.headers["authorization"];
  const match = typeof header === "string" ? header.match(/^Bearer\s+(.+)$/i) : null;
  const presented = match?.[1]?.trim();
  if (!presented) {
    res.status(401).json({ error: "auth_required", message: "Missing or malformed Authorization header." });
    return;
  }

  // Digests rather than the raw values, so the comparison is constant time
  // over a fixed length. timingSafeEqual throws on a length mismatch, which
  // would otherwise leak the token's length to anyone probing.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    res.status(401).json({ error: "token_invalid", message: "Invalid management token." });
    return;
  }

  next();
}
