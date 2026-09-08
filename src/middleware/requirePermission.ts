import type { Request, Response } from "express";

import type { Permission } from "../constants/permissions";
import { hasPermission } from "../services/permissions";

/**
 * The HTTP half, because a route writing its own `role !== "owner"` breaks once a
 * server can define an emoji-only role. Returns false having already answered.
 */
export async function ensurePermission(
  req: Request,
  res: Response,
  permission: Permission,
): Promise<boolean> {
  const serverUserId = req.tokenPayload?.serverUserId;
  if (!serverUserId) {
    res.status(401).json({ error: "auth_required" });
    return false;
  }

  if (await hasPermission(serverUserId, permission, req.tokenPayload?.grytUserId)) {
    return true;
  }

  res.status(403).json({
    error: "forbidden",
    // Names the permission, not a role. With roles editable, "only admins can
    // do this" may be false on the very server that says it.
    message: `You do not have permission to do that (${permission}).`,
    permission,
  });
  return false;
}
