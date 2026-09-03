import {
  ADMIN_ONLY_ROLE_IDS,
  ESCALATION_PERMISSIONS,
  OWNER_ROLE_ID,
} from "../constants/permissions";

/**
 * Which roles an invite may hand out, and whether it still may.
 *
 * An invite is a stored capability. Every other role grant on this server is
 * checked with the actor in the room — `resolveRoleChange` in the admin handler
 * asks for `manage_roles`, that the actor outranks the target, and that the role
 * is strictly below the actor's own rank. An invite defers the grant to a moment
 * nobody is present for, which breaks two of those three:
 *
 * - The creator can lose standing. An admin makes an invite granting moderator
 *   and is demoted a week later. Nothing revisits the invite, so a former admin
 *   holds a link that still mints moderators.
 * - The role can move under the invite. Somebody with `manage_roles` binds a
 *   rank-10 role to a link, then edits that role to rank 90 with everything
 *   ticked. The link now grants near-owner, and no check was ever failed.
 *
 * The second one needs no demotion and no second account, which is why a
 * creation-time check on its own is decoration. So the rules below are applied
 * twice: once when the invite is made, and again when it is redeemed, against
 * the world as it is then.
 *
 * Pure, and in its own file, so the rules can be read and tested without a
 * socket, a database or a join.
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
 * The rules that hold whatever the moment.
 *
 * Checked at creation and again at redemption, because every one of them can
 * stop being true in between: a role's permissions can be widened, its flag
 * cleared, or the role deleted outright.
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
 * May this actor bind this role to an invite they are creating?
 *
 * Strictly below the actor's own rank, matching `resolveRoleChange`: binding a
 * role you do not outrank is granting yourself a promotion two steps removed,
 * and the extra step is the only difference.
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
 * May this invite still grant the role it was bound to?
 *
 * `rankAtCreation` is the rank the role carried when somebody with the standing
 * to do it agreed to hand it out. A role that has climbed since is not the role
 * that was agreed to, so the grant is refused rather than honoured at the new
 * height. Falling is fine: a role that has been demoted grants less than was
 * agreed, which nobody needs protecting from.
 *
 * Deliberately does not consult the creator's standing today. Their rank is not
 * a stable thing to hang a link on — they may have left — and the snapshot plus
 * the rules above already bound what the link can do without needing them to
 * still exist.
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
 * Grant the role an invite was bound to, if it still may.
 *
 * Separate from the pure rules above because this one reaches the database, and
 * because the interesting part is what it does when the answer is no: it writes
 * an audit row and carries on. A refusal here means somebody arrived expecting
 * a role and did not get it, which is indistinguishable from the feature being
 * broken unless it is written down somewhere an operator can find it.
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
