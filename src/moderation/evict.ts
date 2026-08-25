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

    // Take them out of voice before the socket goes.
    //
    // Disconnecting the socket does not touch the media path: socket.io and the
    // SFU peer connection are separate, and the disconnect handler only calls
    // untrackUserConnection, which deletes a local Map entry and tells the SFU
    // nothing. So what actually stopped a kicked user talking was their own
    // client honouring `server_voice_disconnect` and tearing itself down —
    // exactly the honour system server mute was running on before GRYT-130. A
    // client that ignores it keeps talking to everyone still in the room.
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
