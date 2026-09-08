import { getUserByServerId } from "../db/sqlite/users";
import { isUserBanned } from "../db/sqlite/servers";
import type { UserRecord } from "../db/interfaces";

/**
 * If you assign `clientsInfo[id].grytUserId`, call this first. Checking live
 * state here is the invalidation, so a 15-minute token is not a 15-minute hole.
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

/** For the fresh join, where no server user exists yet. Keyed on `grytUserId`,
    so a ban survives a reinstall and a new device. */
export async function checkIdentityAllowed(
  grytUserId: string,
): Promise<IdentityCheck> {
  if (await isUserBanned(grytUserId)) {
    return { ok: false, code: "banned", message: DENIAL_MESSAGES.banned };
  }
  return { ok: true };
}

/** Membership is `users.is_active`: kicking clears it and a fresh join sets it
    back, so a kicked user returns by joining and not by reconnecting. */
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
