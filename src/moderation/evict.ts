import consola from "consola";
import type { Server as SocketIoServer } from "socket.io";

import { getUserByServerId, setUserInactive, revokeUserRefreshTokens } from "../db";
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
