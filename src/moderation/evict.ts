import consola from "consola";
import type { Server as SocketIoServer } from "socket.io";

import { getUserByServerId, setUserInactive, revokeUserRefreshTokens } from "../db";
import { pluginEvents } from "../plugins";
import type { Clients } from "../types";
import { sfuRoomId, voiceRoomName } from "../socket/utils/voiceRooms";
import { forgetStashedVoiceState } from "../socket/utils/voiceStash";

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
 * Removes a user from the server, now, in a way that holds. Disconnecting the
 * socket alone bought half a second — socket.io reconnects, `token:refresh`
 * mints a new access token, the retry loop rejoins. So it is three things:
 *
 *   - `setUserInactive`, which the session gate reads on every admission path,
 *     closing the 15-minute access-token window without touching the
 *     server-global `token_version`
 *   - `revokeUserRefreshTokens`, so no new access token is minted
 *   - disconnecting the sockets, which makes it immediate
 *
 * A kick stops there. **A ban's `bans` row is written by the caller first**, so
 * eviction cannot race a reconnect into the gap.
 *
 * Sockets are matched on the Gryt identity as well as the server user id.
 */
export async function evictUser(params: {
  io: SocketIoServer;
  clientsInfo: Clients;
  serverId: string;
  sfuClient: { disconnectUser(roomId: string, userId: string): Promise<void>; untrackUserConnection(userId: string): void } | null;
  targetServerUserId: string;
  targetGrytUserId: string;
  action: "kick" | "ban";
  reason?: string | null;
}): Promise<void> {
  const { io, clientsInfo, serverId, sfuClient, targetServerUserId, targetGrytUserId, action, reason } = params;

  await setUserInactive(targetServerUserId);
  await revokeUserRefreshTokens(targetGrytUserId);

  // Plugins hear about it (GRYT-933), carrying which of the two this was — a
  // plugin deciding whether to act wants to know a human already has.
  // The row is read rather than the connection, so the name is there whether or
  // not they were online when it happened. Swallowed: a plugin's event is not
  // worth failing a ban over.
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

    // Take them out of voice before the socket goes. Disconnecting does not
    // touch the media path — socket.io and the SFU peer connection are
    // separate — so what stopped a kicked user talking was their own client
    // honouring the event. One that ignores it keeps talking to the room.
    if (ci.hasJoinedChannel && ci.voiceChannelId) {
      const roomId = sfuRoomId(serverId, ci.voiceChannelId);
      if (sfuClient) {
        await sfuClient
          .disconnectUser(roomId, ci.serverUserId)
          .catch((e) => consola.warn("SFU disconnect on eviction failed", e));
        sfuClient.untrackUserConnection(ci.serverUserId);
      }

      // Nothing held against them either. The disconnect handler keeps voice
      // state for anyone whose socket goes while they are in a channel, and the
      // SFU sync puts it back — which for somebody being thrown out is the
      // opposite of what is wanted (GRYT-611).
      forgetStashedVoiceState(ci.serverUserId);

      // Tell the room, and tell them, rather than relying on the disconnect
      // handler, because this is deliberate rather than accidental.
      s.to(voiceRoomName(serverId, ci.voiceChannelId)).emit("voice:peer:left", {
        clientId: sid,
        nickname: ci.nickname,
        channelId: ci.voiceChannelId,
      });
      s.emit("voice:channel:joined", false);
      s.emit("voice:stream:set", "");
      s.emit("voice:room:leave");

      ci.hasJoinedChannel = false;
      ci.voiceChannelId = "";
      ci.streamID = "";
      ci.isConnectedToVoice = false;
    }

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
 * Drop a member's *other* sockets, keeping the one that asked.
 *
 * The sign-out counterpart to `evictUser`, and deliberately not the same
 * function. A kick emits `server:kicked`, which the client reads as "this
 * server is gone" and takes out of the sidebar — right for a ban, wrong for
 * someone tidying up their own sessions, who is still a member and still
 * sitting in the server on the device they did it from.
 *
 * It also does less on purpose: no `setUserInactive`, because signing out is
 * not leaving. The caller has already moved the member's `token_version`, which
 * is what makes the tokens on those other devices useless; this is what makes
 * it immediate rather than waiting for them to speak.
 *
 * Voice is torn down for the sockets that go. Disconnecting does not touch the
 * media path, and the disconnect handler deliberately stashes voice state so a
 * dropped connection can resume — which for a session that was just signed out
 * is the opposite of what is wanted (GRYT-611).
 *
 * Returns how many sockets were dropped, so the caller can tell the member what
 * happened.
 */
export async function disconnectOtherSessions(params: {
  io: SocketIoServer;
  clientsInfo: Clients;
  serverId: string;
  sfuClient: { disconnectUser(roomId: string, userId: string): Promise<void>; untrackUserConnection(userId: string): void } | null;
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

    if (ci.hasJoinedChannel && ci.voiceChannelId) {
      const roomId = sfuRoomId(serverId, ci.voiceChannelId);
      if (sfuClient) {
        await sfuClient
          .disconnectUser(roomId, ci.serverUserId)
          .catch((e) => consola.warn("SFU disconnect on sign-out failed", e));
        sfuClient.untrackUserConnection(ci.serverUserId);
      }
      forgetStashedVoiceState(ci.serverUserId);

      s.to(voiceRoomName(serverId, ci.voiceChannelId)).emit("voice:peer:left", {
        clientId: sid,
        nickname: ci.nickname,
        channelId: ci.voiceChannelId,
      });

      ci.hasJoinedChannel = false;
      ci.voiceChannelId = "";
      ci.streamID = "";
      ci.isConnectedToVoice = false;
    }

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
