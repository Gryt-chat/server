import {
  FALLBACK_ROLE_ID,
  OWNER_ROLE_ID,
  PERMISSIONS,
  type Permission,
} from "../constants/permissions";
import { identityTierOf, type IdentityTier } from "../auth/identity";
import {
  getRoleDefinition,
  getServerConfig,
  getServerRole,
  getUserByServerId,
  listRoleDefinitions,
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
  roleId: string;
  rank: number;
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
const NO_STANDING: EffectiveStanding = {
  roleId: FALLBACK_ROLE_ID,
  rank: 0,
  permissions: new Set<Permission>(),
  isOwner: false,
};

function definitionToStanding(
  def: RoleDefinitionRecord,
  isOwner: boolean,
): EffectiveStanding {
  return {
    roleId: def.role_id,
    rank: def.rank,
    permissions: new Set(def.permissions as Permission[]),
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
 * The role id somebody actually holds, with the two ways it can be wrong
 * already handled.
 *
 * `server_config.owner_gryt_user_id` wins over the roles table, because the
 * owner is a property of the server and the row is only a cache of it. And a
 * role id whose definition has been deleted resolves to the joiner default for
 * that person's identity tier rather than to a hardcoded name — a public server
 * that deletes "Contributor" should drop those people back to whatever it gives
 * strangers, not silently promote them to `member`.
 */
async function resolveRoleId(
  serverUserId: string,
  grytUserId: string | undefined,
  config: ServerConfigRecord | null,
): Promise<{ roleId: string; isOwner: boolean }> {
  const ownerId = config?.owner_gryt_user_id ?? null;

  let subjectGrytId = grytUserId;
  if (!subjectGrytId && ownerId) {
    // Only worth a lookup when there is an owner to compare against.
    subjectGrytId = (await getUserByServerId(serverUserId))?.gryt_user_id;
  }

  if (ownerId && subjectGrytId && ownerId === subjectGrytId) {
    return { roleId: OWNER_ROLE_ID, isOwner: true };
  }

  const stored = await getServerRole(serverUserId);
  if (stored && (await getRoleDefinition(stored))) {
    return { roleId: stored, isOwner: false };
  }

  const tier = subjectGrytId
    ? identityTierOf(subjectGrytId)
    : identityTierOf(
        (await getUserByServerId(serverUserId))?.gryt_user_id ?? "",
      );

  return { roleId: defaultRoleForTier(tier, config), isOwner: false };
}

/**
 * Somebody's role, rank and permissions.
 *
 * Pass `grytUserId` when the caller already has it — every socket event does,
 * off the access token — and it saves the user lookup the owner check would
 * otherwise need.
 */
async function computeStanding(
  serverUserId: string,
  grytUserId?: string,
): Promise<EffectiveStanding> {
  const config = await getServerConfig();
  const { roleId, isOwner } = await resolveRoleId(serverUserId, grytUserId, config);

  const def = await getRoleDefinition(roleId);
  if (def) return definitionToStanding(def, isOwner);

  // The owner's row is missing, which the seeder should make impossible.
  // Falling back to "everything" rather than "nothing" is deliberate and is the
  // one place this module fails open: an owner locked out of their own server
  // has no way back in, and they already hold the machine.
  if (isOwner) {
    return {
      roleId: OWNER_ROLE_ID,
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
