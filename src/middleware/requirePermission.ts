import type { Request, Response } from "express";

import type { Permission } from "../constants/permissions";
import { hasPermission } from "../services/permissions";

/**
 * The HTTP half of the permission check, so both halves say the same thing.
 * Routes each writing their own `role !== "owner"` stops working the moment a
 * server can define a role allowed to manage emoji and nothing else.
 *
 * Returns false having already answered the request, so callers read as
 * `if (!(await ensurePermission(req, res, "manage_emojis"))) return;`.
 *
 * Not express middleware despite living here: the routes it replaces work
 * inside a promise chain after the body is parsed.
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
