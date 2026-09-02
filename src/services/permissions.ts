import {
  FALLBACK_ROLE_ID,
  OWNER_ROLE_ID,
  PERMISSIONS,
  type Permission,
} from "../constants/permissions";
import { identityTierOf, isBotIdentity, type IdentityTier } from "../auth/identity";
import {
  getBotById,
  getRoleDefinition,
  getServerConfig,
  listMemberRoles,
  getUserByServerId,
  listRoleDefinitions,
  listServerRoles,
} from "../db";
import type { RoleDefinitionRecord, ServerConfigRecord } from "../db";

/**
 * Everything the rest of the server needs to know about somebody's standing.
 *
 * Resolved in one place because the three questions are always asked together
 * and used to be answered separately: the middleware worked out a role name,
 * each handler compared it against a name it had written down, and the express
 * routes did their own third version. A moderator who could delete a message
 * over a socket and not over HTTP was that, and it is the kind of gap nobody
 * finds until somebody uses the half that says no.
 */
export interface EffectiveStanding {
  /**
   * The one shown next to their name: the highest ranked they hold.
   *
   * Every caller that draws a role, writes one to an audit line, or compares
   * one against a name uses this. It is a presentation choice, not the answer
   * to what they may do -- that is `permissions`, which is all of them together.
   */
  roleId: string;
  /**
   * Everything they hold, highest ranked first.
   *
   * Channel rules need the whole list rather than the top one, because a scope
   * can name any of them and allow wins. Passing only the top role would have a
   * channel opened to "contributor" refuse somebody who is a contributor and a
   * moderator, which reads as a bug in the channel rather than in the rank.
   */
  roleIds: string[];
  /** The highest rank they hold. What every "outranks" comparison uses. */
  rank: number;
  /** The union of every role's permissions. Roles add, they never subtract. */
  permissions: ReadonlySet<Permission>;
  isOwner: boolean;
}

/**
 * What somebody with no resolvable standing gets: nothing, and a rank that
 * loses every comparison.
 *
 * Returned when the database cannot be read. Failing shut here is the whole
 * point — a hiccup that made every gate answer "yes" would be a far worse
 * outage than one where nobody can post for a minute.
 */
/**
 * What a bot's role reads as everywhere a role id is shown.
 *
 * Not a row in `role_definitions`, on purpose — there is nothing to edit and
 * nothing to assign. It exists so the member list has something to render, and
 * the client shows the BOT tag rather than this.
 */
export const BOT_ROLE_ID = "bot";

const NO_STANDING: EffectiveStanding = {
  roleId: FALLBACK_ROLE_ID,
  roleIds: [FALLBACK_ROLE_ID],
  rank: 0,
  permissions: new Set<Permission>(),
  isOwner: false,
};

/**
 * Several roles, added together.
 *
 * Permissions union and rank takes the highest, which is the only combination
 * that does not surprise: giving somebody a second role can widen what they may
 * do and can raise where they sit, and can never do the opposite. A role that
 * took something away would mean an operator handing out a role and watching
 * somebody lose access, and there would be no order to apply them in that
 * everyone would agree on.
 *
 * `definitions` arrives highest ranked first, so the head is the role shown.
 */
function definitionsToStanding(
  definitions: RoleDefinitionRecord[],
  isOwner: boolean,
): EffectiveStanding {
  const permissions = new Set<Permission>();
  for (const def of definitions) {
    for (const p of def.permissions as Permission[]) permissions.add(p);
  }

  return {
    roleId: definitions[0].role_id,
    roleIds: definitions.map((d) => d.role_id),
    rank: Math.max(...definitions.map((d) => d.rank)),
    permissions,
    isOwner,
  };
}

/**
 * Which role a first-time joiner is given, by how they proved who they are.
 *
 * The tier is read off the stored id rather than carried from the join, so this
 * gives the same answer for somebody rejoining months later as it did the day
 * they arrived — which matters, because the default is also what somebody falls
 * back to when the role they held was deleted.
 */
export function defaultRoleForTier(
  tier: IdentityTier,
  config: Pick<ServerConfigRecord, "default_role_account" | "default_role_local"> | null,
): string {
  if (!config) return FALLBACK_ROLE_ID;
  return tier === "local"
    ? config.default_role_local || FALLBACK_ROLE_ID
    : config.default_role_account || FALLBACK_ROLE_ID;
}

/**
 * The role ids somebody actually holds, with the two ways they can be wrong
 * already handled.
 *
 * `server_config.owner_gryt_user_id` wins over the roles table, because the
 * owner is a property of the server and the row is only a cache of it. And a
 * role id whose definition has been deleted is dropped rather than resolved —
 * a public server that deletes "Contributor" should not have that name keep
 * turning up. Somebody left holding nothing by that falls back to the joiner
 * default for their identity tier rather than to a hardcoded name, so they land
 * on whatever the server gives strangers instead of being silently promoted.
 */
async function resolveRoleIds(
  serverUserId: string,
  grytUserId: string | undefined,
  config: ServerConfigRecord | null,
): Promise<{ roleIds: string[]; isOwner: boolean }> {
  const ownerId = config?.owner_gryt_user_id ?? null;

  let subjectGrytId = grytUserId;
  if (!subjectGrytId && ownerId) {
    // Only worth a lookup when there is an owner to compare against.
    subjectGrytId = (await getUserByServerId(serverUserId))?.gryt_user_id;
  }

  const isOwner = Boolean(ownerId && subjectGrytId && ownerId === subjectGrytId);

  const stored = await listMemberRoles(serverUserId);
  const live: string[] = [];
  for (const roleId of stored) {
    if (await getRoleDefinition(roleId)) live.push(roleId);
  }

  // The owner's role is not read off the table. It is added to whatever else
  // they hold, so an owner who is also a moderator keeps both — and an owner
  // whose row was never written still resolves as one.
  if (isOwner && !live.includes(OWNER_ROLE_ID)) live.unshift(OWNER_ROLE_ID);

  if (live.length > 0) return { roleIds: live, isOwner };

  const tier = subjectGrytId
    ? identityTierOf(subjectGrytId)
    : identityTierOf(
        (await getUserByServerId(serverUserId))?.gryt_user_id ?? "",
      );

  return { roleIds: [defaultRoleForTier(tier, config)], isOwner };
}

/**
 * Somebody's role, rank and permissions.
 *
 * Pass `grytUserId` when the caller already has it — every socket event does,
 * off the access token — and it saves the user lookup the owner check would
 * otherwise need.
 */
/**
 * A bot's standing, which comes from the registry rather than from a role.
 *
 * The whole point of the separation: a bot holds exactly what an operator
 * agreed to, so no edit to a role can widen it and no amount of asking can
 * either. A bot whose registration has been revoked — or which somehow reaches
 * a check without one — resolves to nothing.
 */
async function botStanding(grytUserId: string): Promise<EffectiveStanding> {
  const bot = await getBotById(grytUserId);
  if (!bot || bot.status !== "approved") return NO_STANDING;
  return {
    roleId: BOT_ROLE_ID,
    roleIds: [BOT_ROLE_ID],
    rank: bot.rank,
    permissions: new Set(bot.granted_permissions),
    isOwner: false,
  };
}

async function computeStanding(
  serverUserId: string,
  grytUserId?: string,
): Promise<EffectiveStanding> {
  // Before anything else, and before the owner check: a bot is never the owner,
  // never holds a role, and must never pick up the joining default for a tier
  // it is not in.
  const subject =
    grytUserId ?? (await getUserByServerId(serverUserId))?.gryt_user_id ?? "";
  if (isBotIdentity(subject)) return botStanding(subject);

  const config = await getServerConfig();
  const { roleIds, isOwner } = await resolveRoleIds(serverUserId, grytUserId, config);

  const definitions: RoleDefinitionRecord[] = [];
  for (const roleId of roleIds) {
    const def = await getRoleDefinition(roleId);
    if (def) definitions.push(def);
  }

  if (definitions.length > 0) {
    // Highest rank first, ties broken by the order they were given, so the role
    // shown next to somebody's name does not move between two reads.
    definitions.sort((a, b) => b.rank - a.rank);
    return definitionsToStanding(definitions, isOwner);
  }

  // The owner's row is missing, which the seeder should make impossible.
  // Falling back to "everything" rather than "nothing" is deliberate and is the
  // one place this module fails open: an owner locked out of their own server
  // has no way back in, and they already hold the machine.
  if (isOwner) {
    return {
      roleId: OWNER_ROLE_ID,
      roleIds: [OWNER_ROLE_ID],
      rank: Number.MAX_SAFE_INTEGER,
      permissions: new Set(PERMISSIONS),
      isOwner: true,
    };
  }

  return NO_STANDING;
}

export async function getEffectiveStanding(
  serverUserId: string,
  grytUserId?: string,
): Promise<EffectiveStanding> {
  try {
    return await computeStanding(serverUserId, grytUserId);
  } catch {
    return NO_STANDING;
  }
}

/** Whether somebody may do one specific thing. */
export async function hasPermission(
  serverUserId: string,
  permission: Permission,
  grytUserId?: string,
): Promise<boolean> {
  const standing = await getEffectiveStanding(serverUserId, grytUserId);
  return standing.permissions.has(permission);
}

/**
 * The rank of somebody who is the *target* of an action.
 *
 * Separate from `getEffectiveStanding` only in how it fails: an unreadable
 * target reads as the highest rank there is, so the action is refused. The
 * caller-side version fails the other way for the same reason — both directions
 * end in "no".
 */
export async function getTargetRank(serverUserId: string): Promise<number> {
  try {
    return (await computeStanding(serverUserId)).rank;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Every role this server has defined, for the editor and for the client's copy
 * of who is who.
 */
export async function listRoles(): Promise<RoleDefinitionRecord[]> {
  return listRoleDefinitions();
}

/**
 * Everybody's roles, highest ranked first, in one read.
 *
 * The member list and the role editor both need this and used to build it
 * separately — one keyed a map by member and took whichever row came last,
 * which with one role each was the only row and with two is the more recently
 * granted one. Two answers to "which role is this person shown as" is one more
 * than there should be.
 *
 * A role whose definition has been deleted keeps its place at the end rather
 * than being dropped. This is what is displayed; `getEffectiveStanding` is what
 * decides, and that one already refuses to resolve it.
 */
export async function listRolesByMember(): Promise<Map<string, string[]>> {
  const rankOf = new Map((await listRoleDefinitions()).map((d) => [d.role_id, d.rank]));

  const byMember = new Map<string, string[]>();
  for (const row of await listServerRoles()) {
    const held = byMember.get(row.server_user_id);
    if (held) held.push(row.role);
    else byMember.set(row.server_user_id, [row.role]);
  }

  // Stable: listServerRoles orders by when the role was given, and sort keeps
  // that order for two roles of equal rank — so the name colour of somebody
  // holding two roles of the same rank does not move between reads.
  for (const held of byMember.values()) {
    held.sort((a, b) => (rankOf.get(b) ?? -1) - (rankOf.get(a) ?? -1));
  }

  return byMember;
}
