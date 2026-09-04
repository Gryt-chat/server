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
 * One place, because three separate answers is how a moderator ends up able to
 * delete a message over a socket and not over HTTP.
 */
export interface EffectiveStanding {
  /**
   * The highest ranked they hold, for display. Not the answer to what they may
   * do — that is `permissions`, which is all of them together.
   */
  roleId: string;
  /**
   * Everything they hold, highest ranked first. Channel rules need all of them:
   * a scope can name any, and allow wins — with only the top role, a channel
   * opened to "contributor" refuses a contributor who is also a moderator.
   */
  roleIds: string[];
  /** The highest rank they hold. What every "outranks" comparison uses. */
  rank: number;
  /** The union of every role's permissions. Roles add, they never subtract. */
  permissions: ReadonlySet<Permission>;
  isOwner: boolean;
}

/**
 * No resolvable standing: nothing, and a rank that loses every comparison.
 * Fails shut — a hiccup that made every gate answer yes is the worse outage.
 */
/**
 * What a bot's role reads as. Not a row in `role_definitions`: there is nothing
 * to edit and nothing to assign.
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
 * Several roles added together: permissions union, rank takes the highest. A
 * second role can only ever widen and raise — one that took something away
 * would have no order to apply it in that everybody agrees on.
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
 * Which role a first-time joiner gets, by how they proved who they are. The
 * tier is read off the stored id rather than carried from the join, so somebody
 * whose role was deleted falls back to the same answer months later.
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
 * The role ids somebody actually holds. `server_config.owner_gryt_user_id` wins
 * over the roles table, and a role whose definition was deleted is dropped —
 * somebody left with nothing falls back to the joiner default for their tier
 * rather than to a hardcoded name, so nobody is silently promoted.
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
 * Somebody's role, rank and permissions. Pass `grytUserId` when the caller has
 * it, which saves the lookup the owner check would otherwise need.
 */
/**
 * A bot's standing comes from the registry, not a role, so no role edit can
 * widen it. A revoked or missing registration resolves to nothing.
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
 * The rank of an action's *target*. Differs from `getEffectiveStanding` only in
 * how it fails: unreadable reads as the highest rank, so the action is refused.
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
 * Everybody's roles, highest ranked first, in one read — the member list and
 * the role editor built this separately and disagreed once somebody held two.
 *
 * A deleted role keeps its place at the end. This is what is displayed;
 * `getEffectiveStanding` decides, and that one refuses to resolve it.
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
