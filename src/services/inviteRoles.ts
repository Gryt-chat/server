import {
  ADMIN_ONLY_ROLE_IDS,
  ESCALATION_PERMISSIONS,
  OWNER_ROLE_ID,
} from "../constants/permissions";

/**
 * Checked when the invite is made and again when it is redeemed. A creator can
 * be demoted, and a bound role can be edited upward, after the link exists.
 */

export interface RoleFacts {
  roleId: string;
  rank: number;
  permissions: readonly string[];
  grantableByInvite: boolean;
}

export type InviteRoleRefusal =
  | "unknown_role"
  | "owner_role"
  | "admin_role"
  | "escalation_permission"
  | "not_grantable"
  | "rank_not_below_actor"
  | "rank_raised_since";

export interface InviteRoleVerdict {
  ok: boolean;
  reason?: InviteRoleRefusal;
}

const OK: InviteRoleVerdict = { ok: true };
const no = (reason: InviteRoleRefusal): InviteRoleVerdict => ({ ok: false, reason });

/** Every one can stop being true between creation and redemption, so both ends
    check them. */
function alwaysTrue(role: RoleFacts | null): InviteRoleVerdict {
  if (!role) return no("unknown_role");
  if (role.roleId === OWNER_ROLE_ID) return no("owner_role");

  // By id as well as permission: `admin` holds none of the four escalation
  // permissions and would pass a permission-only test.
  if (ADMIN_ONLY_ROLE_IDS.has(role.roleId)) return no("admin_role");

  if (role.permissions.some((p) => ESCALATION_PERMISSIONS.has(p))) {
    return no("escalation_permission");
  }
  if (!role.grantableByInvite) return no("not_grantable");
  return OK;
}

/** Strictly below their own rank, matching `resolveRoleChange`: binding a role
    you do not outrank is a promotion two steps removed. */
export function mayBindRoleToInvite(
  role: RoleFacts | null,
  actorRank: number,
): InviteRoleVerdict {
  const base = alwaysTrue(role);
  if (!base.ok) return base;
  if (role!.rank >= actorRank) return no("rank_not_below_actor");
  return OK;
}

/** `rankAtCreation` is what was agreed to, so a role that has climbed since is
    refused. The creator's standing today is not consulted. */
export function mayRedeemInviteRole(
  role: RoleFacts | null,
  rankAtCreation: number,
): InviteRoleVerdict {
  const base = alwaysTrue(role);
  if (!base.ok) return base;
  if (role!.rank > rankAtCreation) return no("rank_raised_since");
  return OK;
}

/** Why a refusal happened, for the audit row and the server log. */
export const INVITE_ROLE_REFUSAL_TEXT: Record<InviteRoleRefusal, string> = {
  unknown_role: "no such role",
  owner_role: "the owner role is never granted by invite",
  admin_role: "admin is granted by hand, never by invite",
  escalation_permission: "the role carries a permission that can grant permissions",
  not_grantable: "the role is not marked as grantable by invite",
  rank_not_below_actor: "the role is at or above your own",
  rank_raised_since: "the role has been raised since the invite was made",
};

/** On a refusal it writes an audit row and carries on, or arriving without the
    expected role looks like the feature being broken. */
export async function applyInviteRole(
  inviteCode: string,
  serverUserId: string,
): Promise<void> {
  const { getServerInvite, getRoleDefinition, addMemberRole, insertServerAudit } =
    await import("../db");

  const invite = await getServerInvite(inviteCode);
  if (!invite?.granted_role_id) return;

  const def = await getRoleDefinition(invite.granted_role_id);
  const verdict = mayRedeemInviteRole(
    def && {
      roleId: def.role_id,
      rank: def.rank,
      permissions: def.permissions,
      grantableByInvite: def.grantable_by_invite,
    },
    invite.granted_role_rank ?? Number.NEGATIVE_INFINITY,
  );

  if (!verdict.ok) {
    await insertServerAudit({
      action: "invite_role_refused",
      target: serverUserId,
      meta: {
        code: inviteCode,
        role: invite.granted_role_id,
        reason: verdict.reason,
        detail: INVITE_ROLE_REFUSAL_TEXT[verdict.reason!],
      },
    }).catch(() => {});
    return;
  }

  await addMemberRole(serverUserId, def!.role_id);
  await insertServerAudit({
    action: "invite_role_granted",
    target: serverUserId,
    meta: { code: inviteCode, role: def!.role_id },
  }).catch(() => {});
}
