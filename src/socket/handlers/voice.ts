import { sfuRoomId, voiceRoomName } from "../utils/voiceRooms";
import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth, requireOutranks } from "../middleware/auth";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { getVoiceSeatLimit } from "../../utils/voiceSeats";
import { insertServerAudit } from "../../db";
import { socketIsIdentified, socketMay as socketMayFor } from "../utils/standing";
import { forgetStashedVoiceState } from "../utils/voiceStash";
import { DENIAL_RESPONSES, resolveConversationAccess } from "../utils/conversationAccess";
import { isConversationId } from "../../db";
import { endRingsFor } from "./calls";
import type { Permission } from "../../constants/permissions";
import { mayInChannel } from "../../services/channelPermissions";
import { CAP_SPEAK } from "../../sfu/clientToken";

const RL_REQUEST_ROOM: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 1, maxScore: 8, scoreDecayMs: 5000 };
const RL_JOINED_CHANNEL: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 0.5, maxScore: 6, scoreDecayMs: 3000 };
// Tighter than a real room request: this grants a live SFU credential, and
// nobody needs the Doctor twice a minute.
const RL_DOCTOR_ROOM: RateLimitRule = { limit: 3, windowMs: 60_000, scorePerAction: 2, maxScore: 6, scoreDecayMs: 10_000 };

export function registerVoiceHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient, getClientIp } = ctx;

  /** Voice events carry no access token, so the socket's identity in
      `clientsInfo` is what answers. */
  function socketMay(permission: Permission): Promise<boolean> {
    return socketMayFor(clientsInfo, clientId, permission);
  }

  /** `session:restore` and the voice re-announce race, and `forbidden` is the
      one answer a client will not retry. Its own code, which backs off. */
  function refusedAsUnidentified(): boolean {
    if (socketIsIdentified(clientsInfo, clientId)) return false;

    socket.emit("voice:room:error", {
      error: "unidentified",
      message: "Still working out who you are — try again in a moment.",
      retryAfterMs: 2000,
    });

    return true;
  }

  return {
    'voice:camera:state': async (payload: { enabled: boolean; streamId?: string }) => {
      if (!clientsInfo[clientId]) return;
      const enabled = typeof payload === 'boolean' ? payload : Boolean(payload?.enabled);
      const streamId = typeof payload === 'object' ? (payload.streamId || "") : "";
      // Same race as the room request, one event later: the camera stayed off
      // in the room while still sending. Before the permission check, not instead.
      if (enabled && refusedAsUnidentified()) return;
      // Turning a camera *off* is never refused. A permission that was taken
      // away mid-call would otherwise leave somebody unable to stop streaming.
      if (enabled && !(await socketMay("share_video"))) {
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You do not have permission to share video here.",
          permission: "share_video",
        });
        return;
      }
      clientsInfo[clientId].cameraEnabled = enabled;
      clientsInfo[clientId].cameraStreamID = enabled ? streamId : "";
      syncAllClients(io, clientsInfo);
    },

    'voice:screen:state': async (payload: { enabled: boolean; videoStreamId?: string; audioStreamId?: string }) => {
      if (!clientsInfo[clientId]) return;
      const enabled = typeof payload === 'object' ? Boolean(payload?.enabled) : Boolean(payload);
      const videoStreamId = typeof payload === 'object' ? (payload.videoStreamId || "") : "";
      const audioStreamId = typeof payload === 'object' ? (payload.audioStreamId || "") : "";
      // As above (GRYT-717). Turning a share off is never refused either.
      if (enabled && refusedAsUnidentified()) return;
      if (enabled && !(await socketMay("share_screen"))) {
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You do not have permission to share your screen here.",
          permission: "share_screen",
        });
        return;
      }
      consola.info(`[ScreenShare] voice:screen:state from=${clientId} enabled=${enabled} videoStreamId=${videoStreamId} audioStreamId=${audioStreamId}`);
      clientsInfo[clientId].screenShareEnabled = enabled;
      clientsInfo[clientId].screenShareVideoStreamID = enabled ? videoStreamId : "";
      clientsInfo[clientId].screenShareAudioStreamID = enabled ? audioStreamId : "";
      syncAllClients(io, clientsInfo);
    },

    'voice:state:update': async (clientState: { isMuted: boolean; isDeafened: boolean; isAFK: boolean }) => {
      if (!clientsInfo[clientId]) return;
      // `join_voice` without `speak`. Refuses to record them as unmuted rather
      // than refusing the event, so the mute button still works.
      let isMuted = Boolean(clientState.isMuted);
      /* Unidentified is not unpermitted: muting a socket mid-restore records
         the wrong state on the strength of not knowing yet. */
      if (!isMuted && socketIsIdentified(clientsInfo, clientId) && !(await socketMay("speak"))) {
        isMuted = true;
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You can listen here, but not speak.",
          permission: "speak",
        });
      }
      clientsInfo[clientId].isMuted = isMuted;
      clientsInfo[clientId].isDeafened = Boolean(clientState.isDeafened);
      clientsInfo[clientId].isAFK = Boolean(clientState.isAFK);
      syncAllClients(io, clientsInfo);

      if (sfuClient && clientsInfo[clientId].hasJoinedChannel) {
        const ci = clientsInfo[clientId];
        const effectiveMuted = ci.isMuted || ci.isServerMuted;
        const effectiveDeafened = ci.isDeafened || ci.isServerDeafened;
        sfuClient.updateUserAudioState(sfuRoomId(serverId, ci.voiceChannelId), ci.serverUserId, effectiveMuted, effectiveDeafened).catch((e) => {
          consola.error("Failed to update SFU audio state:", e);
        });
      }
    },

    /** Not part of `voice:state:update`, which rebuilds the member list: this
        arrives a few times a second per camera. Not stored. */
    'voice:framing:set': (framing: { x: number; y: number }) => {
      const ci = clientsInfo[clientId];
      if (!ci || !ci.hasJoinedChannel) return;

      const clamp = (n: number) =>
        Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;

      const roomName = ci.voiceChannelId
        ? voiceRoomName(serverId, ci.voiceChannelId)
        : "";
      if (!roomName) return;

      socket.to(roomName).emit('voice:framing', {
        clientId,
        x: clamp(framing?.x),
        y: clamp(framing?.y),
      });
    },

    'voice:stream:set': (streamID: string) => {
      if (!clientsInfo[clientId]) return;
      const wasInChannel = clientsInfo[clientId].hasJoinedChannel;
      const newJoinedState = streamID.length > 0;
      const serverUserId = clientsInfo[clientId].serverUserId;
      consola.info(`[Voice:stream:set] client=${clientId} user=${serverUserId} streamID="${streamID}" wasInChannel=${wasInChannel}`);

      // Duplicate connection detection
      if (newJoinedState && serverUserId) {
        const existingConnection = Object.entries(clientsInfo).find(
          ([otherId, ci]) => otherId !== clientId && ci.serverUserId === serverUserId && ci.hasJoinedChannel,
        );

        if (existingConnection) {
          const [existingClientId] = existingConnection;
          consola.warn(`Device switch detected for ${serverUserId}`);
          const existingSocket = io.sockets.sockets.get(existingClientId);
          if (existingSocket) {
            const prevChannelId = clientsInfo[existingClientId]?.voiceChannelId || "";
            if (prevChannelId) {
              existingSocket.leave(voiceRoomName(serverId, prevChannelId));
            }
            existingSocket.emit("voice:device:disconnect", {
              type: "device_switch",
              message: "Disconnected: you connected from another device.",
            });
            existingSocket.emit("voice:channel:joined", false);
            existingSocket.emit("voice:stream:set", "");
            existingSocket.emit("voice:room:leave");
            clientsInfo[existingClientId].hasJoinedChannel = false;
            clientsInfo[existingClientId].voiceChannelId = "";
            clientsInfo[existingClientId].streamID = "";
            clientsInfo[existingClientId].cameraEnabled = false;
            clientsInfo[existingClientId].cameraStreamID = "";
            clientsInfo[existingClientId].screenShareEnabled = false;
            clientsInfo[existingClientId].screenShareVideoStreamID = "";
            clientsInfo[existingClientId].screenShareAudioStreamID = "";
            if (sfuClient) sfuClient.untrackUserConnection(serverUserId);
          }
        }

        if (sfuClient) {
          sfuClient.untrackUserConnection(serverUserId);
          const roomId = `${serverUserId}:${streamID}`;
          const allowed = sfuClient.trackUserConnection(roomId, serverUserId);
          if (!allowed) {
            socket.emit("voice:error", { type: "duplicate_connection", message: "Already connected to a voice channel.", source: "sfu" });
            return;
          }
        }
      }

      const prevStreamID = clientsInfo[clientId].streamID;
      if (prevStreamID === streamID) return;

      clientsInfo[clientId].streamID = streamID;
      if (!newJoinedState) {
        if (serverUserId) forgetStashedVoiceState(serverUserId);
        clientsInfo[clientId].cameraEnabled = false;
        clientsInfo[clientId].cameraStreamID = "";
        clientsInfo[clientId].screenShareEnabled = false;
        clientsInfo[clientId].screenShareVideoStreamID = "";
        clientsInfo[clientId].screenShareAudioStreamID = "";
        if (sfuClient && serverUserId) sfuClient.untrackUserConnection(serverUserId);
      }

      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    },

    /** A room of one, because reaching the SFU over HTTP proves nothing. Its
        own event so it never sets `voiceChannelId` to a channel that is not real. */
    'voice:doctor:request': async () => {
      const userId = clientsInfo[clientId]?.serverUserId;
      consola.info(`[Voice:Doctor] request from client=${clientId} user=${userId}`);

      try {
        const rl = checkRateLimit("voice:doctor:request", userId, getClientIp(), RL_DOCTOR_ROOM);
        if (!rl.allowed) {
          socket.emit("voice:doctor:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        if (!(await socketMay("join_voice"))) {
          socket.emit("voice:doctor:error", {
            error: "forbidden",
            message: "You do not have permission to join voice on this server.",
            permission: "join_voice",
          });
          return;
        }

        if (!sfuClient || !sfuClient.isConnected()) {
          socket.emit("voice:doctor:error", {
            error: "sfu_unavailable",
            message: "The server cannot reach its own voice service, so there is nothing to test against.",
          });
          return;
        }

        // Named for the member, so two people testing at once do not hear each
        // other. Nothing else can address it.
        const uniqueRoomId = sfuRoomId(serverId, `doctor:${userId ?? clientId}`);
        await sfuClient.registerRoom(uniqueRoomId);

        /* Always allowed to speak: a room of one, reachable from nothing else,
         * whose whole point is hearing your own microphone back. */
        const joinToken = sfuClient.generateClientJoinToken(uniqueRoomId, userId, [CAP_SPEAK]);
        const sfuPublicRaw = process.env.SFU_PUBLIC_HOST || process.env.SFU_WS_HOST || "";
        const sfuPublicUrls = sfuPublicRaw.split(",").map((h) => h.trim()).filter(Boolean);

        consola.success(`[Voice:Doctor] granted client=${clientId} room=${uniqueRoomId}`);
        socket.emit("voice:doctor:granted", {
          room_id: uniqueRoomId,
          join_token: joinToken,
          sfu_url: sfuPublicUrls[0],
          sfu_urls: sfuPublicUrls,
          timestamp: Date.now(),
        });
      } catch (error) {
        consola.error(`[Voice:Doctor] failed for client=${clientId}:`, error);
        socket.emit("voice:doctor:error", {
          error: "failed",
          message: error instanceof Error ? error.message : "Could not set up a test room",
        });
      }
    },

    'voice:room:request': async (roomId: string) => {
      const userId = clientsInfo[clientId]?.serverUserId;
      consola.info(`[Voice:Step 1] voice:room:request from client=${clientId} user=${userId} room=${roomId}`);
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("voice:room:request", userId, ip, RL_REQUEST_ROOM);
        if (!rl.allowed) {
          consola.warn(`[Voice:Step 1] RATE LIMITED client=${clientId}`);
          socket.emit("voice:room:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!roomId || typeof roomId !== "string") {
          consola.warn(`[Voice:Step 1] Invalid room ID from client=${clientId}: ${roomId}`);
          socket.emit("voice:room:error", "Invalid room ID");
          return;
        }
        if (refusedAsUnidentified()) {
          consola.info(`[Voice:Step 1] not identified yet client=${clientId} — asked to retry`);
          return;
        }
        if (!(await socketMay("join_voice"))) {
          consola.warn(`[Voice:Step 1] FORBIDDEN client=${clientId} user=${userId} lacks join_voice`);
          socket.emit("voice:room:error", {
            error: "forbidden",
            message: "You do not have permission to join voice on this server.",
            permission: "join_voice",
          });
          return;
        }
        /* `join_voice` says whether somebody may use voice, not where, and a
           DM's id is computable from a member list. Same answer chat gets. */
        const access = await resolveConversationAccess(roomId, userId);
        if (!access.allowed) {
          const denial = DENIAL_RESPONSES[access.reason];
          consola.warn(`[Voice:Step 1] REFUSED client=${clientId} user=${userId} room=${roomId} reason=${access.reason}`);
          /* `undetermined` means the rules were unreadable, not that the room
             is gone. Voice gives up after five tries across twenty seconds. */
          socket.emit("voice:room:error", {
            error: denial.error,
            message: denial.message,
            ...(access.reason === "undetermined" ? { retryAfterMs: 3000 } : {}),
          });
          return;
        }

        if (!sfuClient) {
          consola.error(`[Voice:Step 2] SFU client not initialized`);
          socket.emit("voice:room:error", "Voice service unavailable");
          return;
        }
        if (!sfuClient.isConnected()) {
          consola.error(`[Voice:Step 2] SFU client not connected`, sfuClient.getConnectionStatus());
          socket.emit("voice:room:error", "Voice service temporarily unavailable");
          return;
        }

        consola.info(`[Voice:Step 2] SFU client connected, checking seats…`);
        const seatLimit = getVoiceSeatLimit();
        if (seatLimit && seatLimit > 0) {
          const used = sfuClient.getActiveUsers().size;
          consola.info(`[Voice:Step 2] Seat check: ${used}/${seatLimit}`);
          if (used >= seatLimit) {
            consola.warn(`[Voice:Step 2] Server full: ${used}/${seatLimit}`);
            socket.emit("voice:room:error", { error: "server_full", message: `No seats left (${used}/${seatLimit}).`, used, max: seatLimit });
            return;
          }
        }

        if (clientsInfo[clientId]) {
          clientsInfo[clientId].voiceChannelId = roomId;
        }

        const uniqueRoomId = sfuRoomId(serverId, roomId);
        consola.info(`[Voice:Step 3] Registering room ${uniqueRoomId} with SFU…`);
        await sfuClient.registerRoom(uniqueRoomId);
        consola.info(`[Voice:Step 3] Room registered: ${uniqueRoomId}`);

        const serverUserId = clientsInfo[clientId]?.serverUserId;

        /* Audio never reaches this server, so the token is the whole mechanism.
           Against the channel id: `uniqueRoomId` matches no scope. */
        const capabilities = (await mayInChannel(roomId, serverUserId, "speak")) ? [CAP_SPEAK] : [];

        consola.info(`[Voice:Step 4] Generating join token for client=${clientId} user=${serverUserId} room=${uniqueRoomId} caps=[${capabilities.join(",")}]`);
        const joinToken = sfuClient.generateClientJoinToken(uniqueRoomId, serverUserId, capabilities);
        const sfuPublicRaw = process.env.SFU_PUBLIC_HOST || process.env.SFU_WS_HOST || "";
        const sfuPublicUrls = sfuPublicRaw.split(",").map(h => h.trim()).filter(Boolean);
        const sfuPublicUrl = sfuPublicUrls[0];

        consola.success(`[Voice:Step 5] Granting room access: client=${clientId} room=${uniqueRoomId} sfu_urls=${sfuPublicUrls.join(", ")}`);
        socket.emit("voice:room:granted", { room_id: uniqueRoomId, join_token: joinToken, sfu_url: sfuPublicUrl, sfu_urls: sfuPublicUrls, timestamp: Date.now() });
      } catch (error) {
        consola.error(`[Voice:FAIL] Room access error for client=${clientId} room=${roomId}:`, error);
        socket.emit("voice:room:error", error instanceof Error ? error.message : "Failed to grant room access");
      }
    },

    'voice:channel:joined': async (hasJoined: boolean) => {
      if (!clientsInfo[clientId]) return;
      const ip = getClientIp();
      const userId = clientsInfo[clientId]?.serverUserId;
      consola.info(`[Voice:channel:joined] client=${clientId} user=${userId} hasJoined=${hasJoined}`);
      const rl = checkRateLimit("voice:channel:joined", userId, ip, RL_JOINED_CHANNEL);
      if (!rl.allowed) {
        socket.emit("voice:room:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
        return;
      }

      const wasInChannel = clientsInfo[clientId].hasJoinedChannel;
      const newJoinedState = Boolean(hasJoined);
      if (wasInChannel === newJoinedState) return;

      // Joining is refused, leaving never is. The flag is what puts somebody in
      // the member list, so ungated it is a way to appear where you may not be.
      if (newJoinedState && refusedAsUnidentified()) return;

      if (newJoinedState && !(await socketMay("join_voice"))) {
        socket.emit("voice:room:error", {
          error: "forbidden",
          message: "You do not have permission to join voice on this server.",
          permission: "join_voice",
        });
        return;
      }

      const channelId = clientsInfo[clientId].voiceChannelId || "";
      const roomName = channelId ? voiceRoomName(serverId, channelId) : "";

      if (newJoinedState) {
        if (roomName) socket.join(roomName);

        // Answering is joining the room; there is no `call:accept`. Ends the
        // ring on this person's other devices too.
        if (channelId && isConversationId(channelId)) {
          endRingsFor(io, clientsInfo, {
            conversationId: channelId,
            answeredBy: clientsInfo[clientId].serverUserId,
          });
        }
      } else {
        if (roomName) socket.leave(roomName);
      }

      clientsInfo[clientId].hasJoinedChannel = newJoinedState;
      if (!newJoinedState) {
        // Drop what is held, or the SFU sync puts them back: the media
        // connection takes a moment to close and the SFU still has them.
        const leavingUserId = clientsInfo[clientId].serverUserId;
        if (leavingUserId) forgetStashedVoiceState(leavingUserId);
        clientsInfo[clientId].isConnectedToVoice = false;
        clientsInfo[clientId].voiceChannelId = "";
        clientsInfo[clientId].cameraEnabled = false;
        clientsInfo[clientId].cameraStreamID = "";
        clientsInfo[clientId].screenShareEnabled = false;
        clientsInfo[clientId].screenShareVideoStreamID = "";
        clientsInfo[clientId].screenShareAudioStreamID = "";
      }

      syncAllClients(io, clientsInfo);

      /* This sets `hasJoinedChannel`, so it is what announces the call. On
         `voice:stream:set` the first caller got an empty voice view. */
      broadcastMemberList(io, clientsInfo, serverId);

      if (newJoinedState && !wasInChannel) {
        if (roomName) {
          socket.to(roomName).emit("voice:peer:joined", {
            clientId,
            nickname: clientsInfo[clientId].nickname,
            channelId,
          });
        }
      } else if (!newJoinedState && wasInChannel) {
        if (roomName) {
          socket.to(roomName).emit("voice:peer:left", {
            clientId,
            nickname: clientsInfo[clientId].nickname,
            channelId,
          });
        }
      }
    },

    'voice:peer:connected': (streamId: string) => {
      const c = Object.keys(clientsInfo).find((id) => clientsInfo[id].streamID === streamId);
      if (c && clientsInfo[c]) {
        clientsInfo[c].isConnectedToVoice = true;
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
    },

    'voice:peer:disconnected': (streamId: string) => {
      const c = Object.keys(clientsInfo).find((id) => clientsInfo[id].streamID === streamId);
      if (c && clientsInfo[c]) {
        clientsInfo[c].isConnectedToVoice = false;
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
    },

    'voice:disconnect:user': async (payload: { accessToken: string; targetServerUserId: string }) => {
      try {
        if (!payload || typeof payload.targetServerUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId required." });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "disconnect_members" });
        if (!auth) return;

        const targetUserId = payload.targetServerUserId.trim();

        // Without a target check an admin can disconnect the owner from voice,
        // which server:kick has always refused.
        if (!(await requireOutranks(socket, auth, targetUserId, "disconnect"))) return;

        // Find the target user's socket(s)
        const targetEntry = Object.entries(clientsInfo).find(
          ([, ci]) => ci.serverUserId === targetUserId && ci.hasJoinedChannel,
        );

        if (!targetEntry) {
          socket.emit("server:error", { error: "not_found", message: "User is not in a voice channel." });
          return;
        }

        const [targetSocketId, targetClient] = targetEntry;
        const targetSocket = io.sockets.sockets.get(targetSocketId);

        consola.info(`[Voice:kick] actor=${auth.tokenPayload.serverUserId} target=${targetUserId} channel=${targetClient.streamID}`);

        // Tell the SFU to force-close the user's WebRTC connection
        if (sfuClient && targetClient.streamID) {
          // The channel id, not the stream id: the SFU room is
          // `${serverId}_${voiceChannelId}`, so the other addresses nothing.
          const uniqueRoomId = sfuRoomId(serverId, targetClient.voiceChannelId);
          sfuClient.disconnectUser(uniqueRoomId, targetUserId).catch((e) => {
            consola.error("[Voice:kick] SFU disconnectUser failed:", e);
          });
        }

        // Notify the target client
        if (targetSocket) {
          targetSocket.emit("voice:kicked", { reason: "Disconnected from voice by an admin." });
          targetSocket.emit("voice:channel:joined", false);
          targetSocket.emit("voice:stream:set", "");
          targetSocket.emit("voice:room:leave");
        }

        // Notify other clients about the peer leaving
        if (targetSocket) {
          const channelId = targetClient.voiceChannelId || "";
          const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
          if (roomName) {
            targetSocket.leave(roomName);
            targetSocket.to(roomName).emit("voice:peer:left", {
              clientId: targetSocketId,
              nickname: targetClient.nickname,
              channelId,
            });
          }
        }

        // Update server state
        targetClient.hasJoinedChannel = false;
        targetClient.voiceChannelId = "";
        targetClient.streamID = "";
        targetClient.isConnectedToVoice = false;
        targetClient.cameraEnabled = false;
        targetClient.cameraStreamID = "";
        targetClient.screenShareEnabled = false;
        targetClient.screenShareVideoStreamID = "";
        targetClient.screenShareAudioStreamID = "";
        if (sfuClient) sfuClient.untrackUserConnection(targetUserId);

        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "voice_disconnect",
          target: targetUserId,
        }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("voice:disconnect:success", { targetServerUserId: targetUserId });
      } catch (e) {
        consola.error("voice:disconnect:user failed", e);
        socket.emit("server:error", { error: "disconnect_failed", message: "Failed to disconnect user." });
      }
    },
  };
}
