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

/** One place, because three separate answers is how a moderator ends up able to
    delete a message over a socket and not over HTTP. */
export interface EffectiveStanding {
  /** The highest ranked they hold, for display. What they may do is
      `permissions`, which is all of them together. */
  roleId: string;
  /** Channel rules need all of them: a scope can name any and allow wins, so
      the top role alone refuses a contributor who is also a moderator. */
  roleIds: string[];
  /** The highest rank they hold. What every "outranks" comparison uses. */
  rank: number;
  /** The union of every role's permissions. Roles add, they never subtract. */
  permissions: ReadonlySet<Permission>;
  isOwner: boolean;
}

/** What a bot's role reads as. Not a row in `role_definitions`. */
export const BOT_ROLE_ID = "bot";

/** Nothing, at a rank that loses every comparison. Fails shut: a hiccup that
    answered yes to every gate is the worse outage. */
const NO_STANDING: EffectiveStanding = {
  roleId: FALLBACK_ROLE_ID,
  roleIds: [FALLBACK_ROLE_ID],
  rank: 0,
  permissions: new Set<Permission>(),
  isOwner: false,
};

/** Permissions union, rank takes the highest. A second role can only widen and
    raise: taking away needs an order everybody agrees on. */
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

/** The tier is read off the stored id, not carried from the join, so somebody
    whose role was deleted falls back to the same answer months later. */
export function defaultRoleForTier(
  tier: IdentityTier,
  config: Pick<ServerConfigRecord, "default_role_account" | "default_role_local"> | null,
): string {
  if (!config) return FALLBACK_ROLE_ID;
  return tier === "local"
    ? config.default_role_local || FALLBACK_ROLE_ID
    : config.default_role_account || FALLBACK_ROLE_ID;
}

/** `owner_gryt_user_id` beats the roles table, and a deleted definition is
    dropped: the fallback is their tier's default, so nobody is promoted. */
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

  // Added to whatever else they hold, so an owner who is also a moderator keeps
  // both and an owner whose row was never written still resolves as one.
  if (isOwner && !live.includes(OWNER_ROLE_ID)) live.unshift(OWNER_ROLE_ID);

  if (live.length > 0) return { roleIds: live, isOwner };

  const tier = subjectGrytId
    ? identityTierOf(subjectGrytId)
    : identityTierOf(
        (await getUserByServerId(serverUserId))?.gryt_user_id ?? "",
      );

  return { roleIds: [defaultRoleForTier(tier, config)], isOwner };
}

/** From the registry, not a role, so no role edit can widen it. A revoked or
    missing registration resolves to nothing. */
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
  // Before the owner check: a bot is never the owner and must never pick up the
  // joining default for a tier it is not in.
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

  // The one place this module fails open: an owner locked out of their own
  // server has no way back in, and they already hold the machine.
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

/** Differs from `getEffectiveStanding` only in how it fails: unreadable reads
    as the highest rank, so the action is refused. */
export async function getTargetRank(serverUserId: string): Promise<number> {
  try {
    return (await computeStanding(serverUserId)).rank;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Every role this server has defined. */
export async function listRoles(): Promise<RoleDefinitionRecord[]> {
  return listRoleDefinitions();
}

/** One read, because the member list and the role editor built this separately
    and disagreed. Display only; `getEffectiveStanding` decides. */
export async function listRolesByMember(): Promise<Map<string, string[]>> {
  const rankOf = new Map((await listRoleDefinitions()).map((d) => [d.role_id, d.rank]));

  const byMember = new Map<string, string[]>();
  for (const row of await listServerRoles()) {
    const held = byMember.get(row.server_user_id);
    if (held) held.push(row.role);
    else byMember.set(row.server_user_id, [row.role]);
  }

  // Stable: listServerRoles orders by when a role was given and sort keeps that
  // order, so two roles of equal rank do not swap the name colour between reads.
  for (const held of byMember.values()) {
    held.sort((a, b) => (rankOf.get(b) ?? -1) - (rankOf.get(a) ?? -1));
  }

  return byMember;
}
