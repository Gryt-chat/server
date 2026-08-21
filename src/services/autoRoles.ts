import consola from "consola";

import { OWNER_ROLE_ID } from "../constants/permissions";
import {
  countMessagesBySender,
  getUserByServerId,
  insertServerAudit,
  listRoleDefinitions,
  setServerRole,
} from "../db";
import type { RoleDefinitionRecord } from "../db";
import { getEffectiveStanding } from "./permissions";

/**
 * Roles that hand themselves out.
 *
 * A public server wants a tier in the middle that nobody has to award by hand:
 * somebody who has been around a fortnight and posted a bit stops being a
 * stranger and gets to attach files and join voice. Doing that manually does
 * not scale past the point where it starts to matter, and not doing it at all
 * means either trusting everybody on arrival or trusting nobody.
 *
 * Four decisions, all of them the conservative reading:
 *
 * - **Both conditions, not either.** A role asking for fourteen days and fifty
 *   messages needs both. Time alone would hand the tier to an account that
 *   signed up a month ago and has never spoken, which is exactly the account a
 *   patient spammer brings.
 * - **Promotion only.** Nothing here ever removes a role. Somebody who goes
 *   quiet does not slide back down, and a member already at or above the
 *   role's rank is left alone — so an automatic tier can never demote a
 *   moderator who happens not to post much.
 * - **Evaluated when the member is here**, on joining and after they send a
 *   message, rather than by a sweeper. Those are the two moments the answer
 *   can change, and a background job is a second thing that can fail quietly.
 *   The cost is that a promotion earned while away lands the next time they
 *   turn up, which is the moment it starts to matter anyway.
 * - **Audited with no actor**, because nobody performed it. The entry says
 *   which role and what it asked for, so "why is this person suddenly able to
 *   upload" has an answer that does not require reading this file.
 */

/** What a role asked for, recorded on the audit entry that granted it. */
interface GrantReason {
  afterDays: number | null;
  afterMessages: number | null;
  daysHere: number;
  messagesSent: number;
}

function qualifies(
  role: RoleDefinitionRecord,
  daysHere: number,
  messagesSent: number,
): boolean {
  const { auto_grant_after_days: days, auto_grant_after_messages: messages } = role;
  if (days === null && messages === null) return false;
  if (days !== null && daysHere < days) return false;
  if (messages !== null && messagesSent < messages) return false;
  return true;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whether any role on this server grants itself at all.
 *
 * Asked first so the common case — a server that has configured none of this,
 * which is every server until somebody opens the editor — costs one read of a
 * five-row table and no message count.
 */
function anyRoleAutoGrants(roles: RoleDefinitionRecord[]): boolean {
  return roles.some(
    (r) => r.auto_grant_after_days !== null || r.auto_grant_after_messages !== null,
  );
}

export interface AutoGrantResult {
  granted: RoleDefinitionRecord;
  reason: GrantReason;
}

/**
 * Promote somebody if they have earned it, and say so if they did.
 *
 * Returns null in the ordinary case, which is almost every call. Never throws:
 * this runs off the back of joining and of sending a message, and neither
 * should fail because a promotion could not be worked out.
 */
export async function applyAutoRoles(
  serverUserId: string,
  grytUserId?: string,
): Promise<AutoGrantResult | null> {
  try {
    const roles = await listRoleDefinitions();
    if (!anyRoleAutoGrants(roles)) return null;

    const standing = await getEffectiveStanding(serverUserId, grytUserId);
    // The owner is not something to be promoted into or out of.
    if (standing.isOwner) return null;

    const user = await getUserByServerId(serverUserId);
    if (!user) return null;

    const daysHere = Math.floor(
      (Date.now() - user.created_at.getTime()) / MS_PER_DAY,
    );

    // Only counted once it might matter. A server with a role asking for
    // fourteen days does not need a COUNT(*) from somebody who joined today.
    const couldQualifyOnTime = roles.some(
      (r) =>
        r.rank > standing.rank &&
        r.role_id !== OWNER_ROLE_ID &&
        (r.auto_grant_after_days === null || daysHere >= r.auto_grant_after_days),
    );
    if (!couldQualifyOnTime) return null;

    const messagesSent = await countMessagesBySender(serverUserId);

    // Highest rank they have earned, so a server with three tiers does not
    // promote somebody one step per message.
    const earned = roles
      .filter((r) => r.role_id !== OWNER_ROLE_ID && r.rank > standing.rank)
      .filter((r) => qualifies(r, daysHere, messagesSent))
      .sort((a, b) => b.rank - a.rank)[0];

    if (!earned) return null;

    await setServerRole(serverUserId, earned.role_id);

    const reason: GrantReason = {
      afterDays: earned.auto_grant_after_days,
      afterMessages: earned.auto_grant_after_messages,
      daysHere,
      messagesSent,
    };

    // No actor: nobody did this. The moderation actions all name who performed
    // them, and inventing a name here would make the log lie about the one
    // entry where the answer is "the rules did".
    insertServerAudit({
      actorServerUserId: null,
      action: "role_auto_granted",
      target: serverUserId,
      meta: { role: earned.role_id, from: standing.roleId, ...reason },
    }).catch((e) => consola.warn("audit log write failed", e));

    consola.info(
      `Auto-granted ${earned.role_id} to ${serverUserId} (${daysHere}d, ${messagesSent} messages)`,
    );

    return { granted: earned, reason };
  } catch (e) {
    consola.warn("auto role evaluation failed", e);
    return null;
  }
}
