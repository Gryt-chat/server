import type { Server as SocketIoServer } from "socket.io";

import { getUserByServerId, setUserInactive, revokeUserRefreshTokens } from "../db";
import { pluginEvents } from "../plugins";
import type { Clients } from "../types";
import { removeFromVoice, type VoiceSfu } from "../socket/utils/voiceLeave";

/** Bans and refresh tokens are keyed on `gryt_user_id` while the moderation
    events speak `serverUserId`. */
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
 * Three things, because disconnecting alone buys half a second before the retry
 * loop rejoins. A ban's row is written by the caller first, not here.
 */
export async function evictUser(params: {
  io: SocketIoServer;
  clientsInfo: Clients;
  serverId: string;
  sfuClient: VoiceSfu | null;
  targetServerUserId: string;
  targetGrytUserId: string;
  action: "kick" | "ban";
  reason?: string | null;
}): Promise<void> {
  const { io, clientsInfo, serverId, sfuClient, targetServerUserId, targetGrytUserId, action, reason } = params;

  await setUserInactive(targetServerUserId);
  await revokeUserRefreshTokens(targetGrytUserId);

  // The row rather than the connection, so the name is there whether or not they
  // were online. Swallowed: a plugin event is not worth failing a ban over.
  const evicted = await getUserByServerId(targetServerUserId).catch(() => null);
  pluginEvents().emit("member:left", {
    userId: targetServerUserId,
    nickname: evicted?.nickname ?? null,
    reason: action === "ban" ? "banned" : "kicked",
    at: new Date().toISOString(),
  });

  const fallback =
    action === "ban"
      ? "You were banned from this server."
      : "You were kicked from this server.";
  const trimmed = reason?.trim();

  for (const [sid, s] of io.sockets.sockets) {
    const ci = clientsInfo[sid];
    if (!ci) continue;
    if (ci.serverUserId !== targetServerUserId && ci.grytUserId !== targetGrytUserId) continue;

    // Before the socket goes: disconnecting does not touch the media path, so
    // a client that ignores the event keeps talking to the room.
    await removeFromVoice({ io, clientsInfo, serverId, sfuClient, sid });

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

/**
 * Not `evictUser`: no `server:kicked`, which drops the server from the sidebar,
 * and no `setUserInactive`, because signing out is not leaving.
 */
export async function disconnectOtherSessions(params: {
  io: SocketIoServer;
  clientsInfo: Clients;
  serverId: string;
  sfuClient: VoiceSfu | null;
  targetGrytUserId: string;
  keepSocketId: string;
}): Promise<number> {
  const { io, clientsInfo, serverId, sfuClient, targetGrytUserId, keepSocketId } = params;
  let dropped = 0;

  for (const [sid, s] of io.sockets.sockets) {
    if (sid === keepSocketId) continue;
    const ci = clientsInfo[sid];
    if (!ci) continue;
    if (ci.grytUserId !== targetGrytUserId) continue;

    await removeFromVoice({ io, clientsInfo, serverId, sfuClient, sid });

    // The same event the gates emit when a stale token turns up, so a client
    // that already knows how to react to one needs nothing new for this.
    s.emit("token:revoked", {
      reason: "signed_out_elsewhere",
      message: "You signed out of this device from somewhere else.",
    });
    s.disconnect(true);
    dropped += 1;
  }

  return dropped;
}
