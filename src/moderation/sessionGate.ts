import { getUserByServerId } from "../db/sqlite/users";
import { isUserBanned } from "../db/sqlite/servers";
import type { UserRecord } from "../db/interfaces";

/**
 * The one place a session is allowed or refused.
 *
 * Before this existed the ban check lived at exactly one call site — the fresh
 * `server:verify` join — and every other way of becoming somebody skipped it.
 * A reconnecting client never performs a fresh join, so a banned user could
 * reconnect with a live token, refresh it indefinitely, and keep full access to
 * the HTTP API. A kick lasted about half a second.
 *
 * **If you assign `clientsInfo[id].grytUserId`, call this first.** That
 * invariant is greppable, which "remember to check bans" was not.
 *
 * There is no separate token-invalidation mechanism, and deliberately so.
 * Checking live state here *is* the invalidation: an access token stays
 * cryptographically valid until it expires, but it stops authorising anything
 * the moment the ban lands. That is why the 15-minute token lifetime is not a
 * 15-minute hole, and why none of this needs to touch `token_version` — which
 * is server-global and would sign every user out to eject one.
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
 * Whether this Gryt identity is allowed on the server at all.
 *
 * For the fresh-join path, which knows the identity before any server user
 * exists for it, so membership is not yet a question.
 *
 * The ban is keyed on `grytUserId` — the `sub` of the identity certificate —
 * so it survives a reinstall, a new device and a new server user id.
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
 *
 * Returns the user record on success so callers do not read it a second time —
 * every admission path needs it anyway, for the nickname if nothing else.
 *
 * Membership is `users.is_active`, which is what makes a kick hold: kicking
 * clears it, and `upsertUser` sets it back on a fresh join, so a kicked user
 * can return by joining again but cannot be restored by a reconnect.
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
