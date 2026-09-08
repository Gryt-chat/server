/**
 * A plugin holds no role, so the rule is a sentence rather than a rank: it
 * cannot act on a moderator. A threshold would move when roles are renumbered.
 */

import type { EffectiveStanding } from "../services/permissions";
import type { Permission } from "../constants/permissions";

/** Each of these can remove or silence a member, or hand somebody else the
    ability to. `manage_roles` grants itself `ban_members`. */
export const PROTECTED_PERMISSIONS: readonly Permission[] = [
  "kick_members",
  "ban_members",
  "mute_members",
  "manage_messages",
  "manage_roles",
];

export type Reach =
  | { allowed: true }
  | { allowed: false; reason: string };

/** An unreadable member resolves to rank 0 and so is reachable, which is the
    right way round. That they exist at all is the caller's question. */
export function pluginMayActOn(standing: EffectiveStanding): Reach {
  if (standing.isOwner) {
    return { allowed: false, reason: "that member owns this server" };
  }

  for (const permission of PROTECTED_PERMISSIONS) {
    if (standing.permissions.has(permission)) {
      return {
        allowed: false,
        reason: `that member is a moderator here (${permission})`,
      };
    }
  }

  return { allowed: true };
}
