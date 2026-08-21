import type { Request, Response } from "express";

import type { Permission } from "../constants/permissions";
import { hasPermission } from "../services/permissions";

/**
 * The HTTP half of the permission check, so both halves say the same thing.
 *
 * Every route that needed a role used to write its own `role !== "owner" &&
 * role !== "admin"`, each with its own message and its own idea of who counts.
 * That was survivable while there were four roles and the list was the same
 * everywhere; it stops being survivable the moment a server can define a role
 * that is allowed to manage emoji and nothing else, because the check has to
 * ask about the capability rather than about the name.
 *
 * Returns false having already answered the request, so callers read as
 * `if (!(await ensurePermission(req, res, "manage_emojis"))) return;`.
 *
 * Not an express middleware despite living here: the routes it replaces do
 * their work inside a promise chain after the body has been parsed, and
 * threading a `next()` through those would be a bigger change than the check
 * itself.
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
