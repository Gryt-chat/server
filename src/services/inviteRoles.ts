import {
  ADMIN_ONLY_ROLE_IDS,
  ESCALATION_PERMISSIONS,
  OWNER_ROLE_ID,
} from "../constants/permissions";

/**
 * Which roles an invite may hand out, and whether it still may.
 *
 * An invite is a stored capability, granted at a moment nobody is present for,
 * which breaks two of the checks `resolveRoleChange` makes with the actor in
 * the room. The creator can be demoted and still hold a link that mints
 * moderators. And the role can move under the invite — bind a rank-10 role,
 * then edit it to rank 90 with everything ticked, and the link grants
 * near-owner with no check ever failed.
 *
 * **So the rules below are applied twice**: once when the invite is made, and
 * again when it is redeemed, against the world as it is then. A creation-time
 * check on its own is decoration.
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

/**
 * The rules that hold whatever the moment. Every one can stop being true
 * between creation and redemption, so both ends check them.
 */
function alwaysTrue(role: RoleFacts | null): InviteRoleVerdict {
  if (!role) return no("unknown_role");
  if (role.roleId === OWNER_ROLE_ID) return no("owner_role");

  // By id as well as by permission, because `admin` holds none of the four
  // escalation permissions — those are owner-only — and would otherwise pass a
  // permission-only test. Admin is the role people mean when they say somebody
  // has to be made an admin by hand.
  if (ADMIN_ONLY_ROLE_IDS.has(role.roleId)) return no("admin_role");

  if (role.permissions.some((p) => ESCALATION_PERMISSIONS.has(p))) {
    return no("escalation_permission");
  }
  if (!role.grantableByInvite) return no("not_grantable");
  return OK;
}

/**
 * May this actor bind this role to an invite? Strictly below their own rank,
 * matching `resolveRoleChange` — binding a role you do not outrank is granting
 * yourself a promotion two steps removed.
 */
export function mayBindRoleToInvite(
  role: RoleFacts | null,
  actorRank: number,
): InviteRoleVerdict {
  const base = alwaysTrue(role);
  if (!base.ok) return base;
  if (role!.rank >= actorRank) return no("rank_not_below_actor");
  return OK;
}

/**
 * May this invite still grant the role it was bound to? `rankAtCreation` is
 * what was agreed to, so a role that has climbed since is refused rather than
 * honoured at the new height. Falling is fine.
 *
 * Deliberately does not consult the creator's standing today — they may have
 * left, and the snapshot already bounds what the link can do.
 */
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

/**
 * Grant the role an invite was bound to, if it still may. On a refusal it
 * writes an audit row and carries on — somebody arriving without the role they
 * expected is indistinguishable from the feature being broken otherwise.
 */
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
