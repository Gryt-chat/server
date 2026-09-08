import { createHash, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * The token covers the host's own users and Compose covers everybody else. No
 * peer-address check: in a container loopback arrives from the bridge gateway.
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

  // Digests, so the comparison is constant time over a fixed length:
  // timingSafeEqual throws on a mismatch and would leak the token's length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    res.status(401).json({ error: "token_invalid", message: "Invalid management token." });
    return;
  }

  next();
}
