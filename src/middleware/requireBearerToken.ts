import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, TokenPayload } from "../utils/jwt";
import { getServerConfig } from "../db/scylla";

declare global {
  namespace Express {
    interface Request {
      tokenPayload?: TokenPayload;
    }
  }
}

/**
 * Express middleware that validates the Bearer access token JWT
 * and attaches the decoded payload to `req.tokenPayload`.
 */
export async function requireBearerToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") {
    res.status(401).json({ error: "auth_required", message: "Missing Authorization header." });
    return;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    res.status(401).json({ error: "auth_required", message: "Invalid Authorization header format." });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: "token_invalid", message: "Invalid or expired access token." });
    return;
  }

  const host = req.headers.host || "unknown";
  if (payload.serverHost !== host) {
    res.status(403).json({ error: "forbidden", message: "Token not valid for this server." });
    return;
  }

  // Validate token version
  try {
    const cfg = await getServerConfig();
    const currentVersion = cfg?.token_version ?? 0;
    if ((payload.tokenVersion ?? 0) !== currentVersion) {
      res.status(401).json({ error: "token_stale", message: "Session stale. Please rejoin the server." });
      return;
    }
  } catch {
    // If DB is unavailable, let the request through (token is valid JWT)
  }

  req.tokenPayload = payload;
  next();
}
