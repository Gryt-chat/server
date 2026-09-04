import { getUserByServerId } from "../db/sqlite/users";
import { isUserBanned } from "../db/sqlite/servers";
import type { UserRecord } from "../db/interfaces";

/**
 * The one place a session is allowed or refused. The ban check used to live
 * only at the fresh `server:verify` join, and a reconnecting client never
 * performs one — so a banned user could reconnect on a live token and refresh
 * it indefinitely.
 *
 * **If you assign `clientsInfo[id].grytUserId`, call this first.** That
 * invariant is greppable, which "remember to check bans" was not.
 *
 * There is no separate token invalidation, deliberately: checking live state
 * here *is* the invalidation, which is why a 15-minute token is not a
 * 15-minute hole and why nothing needs to touch the server-global
 * `token_version`.
 */

export type SessionDenialCode = "banned" | "membership_required";

export type SessionDenial = {
  ok: false;
  code: SessionDenialCode;
  message: string;
};

export type SessionCheck = { ok: true; user: UserRecord } | SessionDenial;

export type IdentityCheck = { ok: true } | SessionDenial;

const DENIAL_MESSAGES: Record<SessionDenialCode, string> = {
  banned: "You are banned from this server.",
  membership_required: "You are no longer a member of this server. Please rejoin.",
};

/**
 * Whether this Gryt identity is allowed on the server at all, for the
 * fresh-join path where no server user exists yet. Keyed on `grytUserId`, so a
 * ban survives a reinstall, a new device and a new server user id.
 */
export async function checkIdentityAllowed(
  grytUserId: string,
): Promise<IdentityCheck> {
  if (await isUserBanned(grytUserId)) {
    return { ok: false, code: "banned", message: DENIAL_MESSAGES.banned };
  }
  return { ok: true };
}

/**
 * Whether this identity may hold a session as this server user right now.
 * Returns the user record, which every admission path needs anyway.
 *
 * Membership is `users.is_active`: kicking clears it and `upsertUser` sets it
 * back on a fresh join, so a kicked user can return by joining and cannot be
 * restored by a reconnect.
 */
export async function checkSessionAllowed(params: {
  grytUserId: string;
  serverUserId: string;
}): Promise<SessionCheck> {
  const identity = await checkIdentityAllowed(params.grytUserId);
  if (!identity.ok) return identity;

  const user = await getUserByServerId(params.serverUserId);
  if (!user || !user.is_active) {
    return {
      ok: false,
      code: "membership_required",
      message: DENIAL_MESSAGES.membership_required,
    };
  }

  return { ok: true, user };
}
