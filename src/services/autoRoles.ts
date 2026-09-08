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
 * Both conditions rather than either, promotion only, evaluated on join and
 * after a message rather than by a sweeper, and audited with no actor.
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

/** Asked first, so a server using none of this costs one small read and no
    message count. */
function anyRoleAutoGrants(roles: RoleDefinitionRecord[]): boolean {
  return roles.some(
    (r) => r.auto_grant_after_days !== null || r.auto_grant_after_messages !== null,
  );
}

export interface AutoGrantResult {
  granted: RoleDefinitionRecord;
  reason: GrantReason;
}

/** Never throws: this runs off joining and off sending a message, and neither
    should fail over a promotion. */
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

    // No actor, because nobody did this. Inventing one would make the log lie
    // about the entry where the answer is "the rules did".
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
