import type { Server as SocketIoServer } from "socket.io";

import { getUserByServerId, setUserInactive, revokeUserRefreshTokens } from "../db";
import type { Clients } from "../types";

/**
 * The Gryt identity behind a server user, from a live session if there is one
 * and the database otherwise. Needed because bans and refresh tokens are keyed
 * on `gryt_user_id` while the moderation events speak `serverUserId`.
 */
export async function resolveGrytUserId(
  clientsInfo: Clients,
  targetServerUserId: string,
): Promise<string | undefined> {
  for (const ci of Object.values(clientsInfo)) {
    if (ci.serverUserId === targetServerUserId && ci.grytUserId) return ci.grytUserId;
  }
  const user = await getUserByServerId(targetServerUserId);
  return user?.gryt_user_id;
}

/**
 * Removes a user from the server, now, in a way that holds.
 *
 * Disconnecting the socket was all this used to do, and it bought about half a
 * second: the client kept its refresh token, socket.io reconnected on its own,
 * `token:refresh` minted a new access token, and the retry loop rejoined. So
 * eviction is three things, not one:
 *
 *   - `setUserInactive` stops existing access tokens authorising anything,
 *     because the session gate reads `is_active` on every admission path. This
 *     is what closes the 15-minute access-token window without any token
 *     surgery, and without touching the server-global `token_version`.
 *   - `revokeUserRefreshTokens` stops a new access token being minted.
 *   - disconnecting the sockets makes it immediate rather than eventual.
 *
 * A kick stops there, and `upsertUser` sets `is_active` back on a fresh join,
 * so the user can return by joining again. A ban additionally writes the `bans`
 * row that the gate refuses on, and the caller writes that first so eviction
 * cannot race a reconnect into the gap.
 *
 * Sockets are matched on the Gryt identity as well as the server user id, so
 * every session that identity holds goes, not only the ones that happened to
 * finish a join.
 */
export async function evictUser(params: {
  io: SocketIoServer;
  clientsInfo: Clients;
  targetServerUserId: string;
  targetGrytUserId: string;
  action: "kick" | "ban";
  reason?: string | null;
}): Promise<void> {
  const { io, clientsInfo, targetServerUserId, targetGrytUserId, action, reason } = params;

  await setUserInactive(targetServerUserId);
  await revokeUserRefreshTokens(targetGrytUserId);

  const fallback =
    action === "ban"
      ? "You were banned from this server."
      : "You were kicked from this server.";
  const trimmed = reason?.trim();

  for (const [sid, s] of io.sockets.sockets) {
    const ci = clientsInfo[sid];
    if (!ci) continue;
    if (ci.serverUserId !== targetServerUserId && ci.grytUserId !== targetGrytUserId) continue;

    s.emit("server:kicked", {
      action,
      // `reason` is the whole payload for clients that predate this and read it
      // as the message to show, so it has to stay a human-readable sentence.
      reason: trimmed ? `${fallback} Reason: ${trimmed}` : fallback,
      moderatorReason: trimmed || null,
    });
    s.disconnect(true);
  }
}
