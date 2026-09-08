import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, TokenPayload } from "../utils/jwt";
import { getServerConfig } from "../db";
import { checkSessionAllowed } from "../moderation/sessionGate";

declare module "express-serve-static-core" {
  interface Request {
    tokenPayload?: TokenPayload;
  }
}

/** Validates the Bearer access token and attaches the payload to
    `req.tokenPayload`. */
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

  // Not fail-open, unlike the check above: a banned user holding a valid token is
  // what this exists to stop, so an unreadable database means no.
  try {
    const gate = await checkSessionAllowed({
      grytUserId: payload.grytUserId,
      serverUserId: payload.serverUserId,
    });
    if (!gate.ok) {
      res.status(403).json({ error: gate.code, message: gate.message });
      return;
    }

    // On the row the gate already loaded, so no extra query. This is what makes
    // signing out everywhere end the running sessions rather than wait them out.
    if ((payload.userTokenVersion ?? 0) !== (gate.user.token_version ?? 0)) {
      res.status(401).json({ error: "token_revoked", message: "Session ended. Please sign in again." });
      return;
    }
  } catch {
    res.status(503).json({ error: "unavailable", message: "Could not verify membership." });
    return;
  }

  req.tokenPayload = payload;
  next();
}
