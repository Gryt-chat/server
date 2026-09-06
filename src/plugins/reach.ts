/**
 * Who a plugin is allowed to act on (GRYT-935).
 *
 * A plugin is not a member. It holds no role, so the rank comparison every
 * human moderation path uses — `requireOutranks` — has nothing to compare
 * against. Something has to take its place, because the alternative is a
 * plugin that can ban the owner.
 *
 * The rule is a sentence rather than a number: **a plugin cannot act on a
 * moderator.** Anybody who could take somebody else out is out of a plugin's
 * reach, and so is the owner. That is deliberately not "rank below N" — role
 * ranks are the operator's to arrange, and a rule written against them would
 * mean renumbering roles quietly changed who a plugin could ban.
 *
 * It is coarse on purpose. A plugin acting on ordinary members is the whole
 * use — an automod that bans somebody posting the same thing in every channel
 * — and a plugin acting on the people who would notice it misbehaving is the
 * failure worth designing out. The bug that would otherwise happen at three in
 * the morning is a loop that bans everybody who speaks, starting with whoever
 * is awake to stop it.
 */

import type { EffectiveStanding } from "../services/permissions";
import type { Permission } from "../constants/permissions";

/**
 * Holding any of these puts somebody out of reach.
 *
 * Every one of them can remove or silence another member, or hand somebody
 * else the ability to. `manage_roles` is in the list because granting yourself
 * `ban_members` is the same thing one step removed.
 */
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

/**
 * Pure, so the rule can be read and tested without a database.
 *
 * `getEffectiveStanding` already fails shut — an unreadable member resolves to
 * no permissions and rank 0 — which would make them *reachable* rather than
 * protected. That is the right way round: the failure it guards is a plugin
 * acting on a moderator, and a member whose standing cannot be read is not a
 * moderator by any evidence available. The caller still has to establish that
 * the member exists at all, which is a different question and is answered
 * before this is called.
 */
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
