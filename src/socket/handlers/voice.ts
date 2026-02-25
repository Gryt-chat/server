import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { insertServerAudit } from "../../db/scylla";

const RL_REQUEST_ROOM: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 1, maxScore: 8, scoreDecayMs: 5000 };
const RL_JOINED_CHANNEL: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 0.5, maxScore: 6, scoreDecayMs: 3000 };

function voiceRoomName(serverId: string, channelId: string): string {
  return `voice:${serverId}:${channelId}`;
}

function getVoiceSeatLimit(): number | null {
  const explicit = parseInt(process.env.VOICE_MAX_USERS || "0", 10);
  if (explicit > 0) return explicit;
  const min = parseInt(process.env.SFU_UDP_PORT_MIN || "0", 10);
  const max = parseInt(process.env.SFU_UDP_PORT_MAX || "0", 10);
  if (min > 0 && max >= min) return max - min + 1;
  return null;
}

export function registerVoiceHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient, getClientIp } = ctx;

  return {
    'voice:camera:state': (payload: { enabled: boolean; streamId?: string }) => {
      if (!clientsInfo[clientId]) return;
      const enabled = typeof payload === 'boolean' ? payload : Boolean(payload?.enabled);
      const streamId = typeof payload === 'object' ? (payload.streamId || "") : "";
      clientsInfo[clientId].cameraEnabled = enabled;
      clientsInfo[clientId].cameraStreamID = enabled ? streamId : "";
      syncAllClients(io, clientsInfo);
    },

    'voice:screen:state': (payload: { enabled: boolean; videoStreamId?: string; audioStreamId?: string }) => {
      if (!clientsInfo[clientId]) return;
      const enabled = typeof payload === 'object' ? Boolean(payload?.enabled) : Boolean(payload);
      const videoStreamId = typeof payload === 'object' ? (payload.videoStreamId || "") : "";
      const audioStreamId = typeof payload === 'object' ? (payload.audioStreamId || "") : "";
      clientsInfo[clientId].screenShareEnabled = enabled;
      clientsInfo[clientId].screenShareVideoStreamID = enabled ? videoStreamId : "";
      clientsInfo[clientId].screenShareAudioStreamID = enabled ? audioStreamId : "";
      syncAllClients(io, clientsInfo);
    },

    'voice:state:update': (clientState: { isMuted: boolean; isDeafened: boolean; isAFK: boolean }) => {
      if (!clientsInfo[clientId]) return;
      clientsInfo[clientId].isMuted = Boolean(clientState.isMuted);
      clientsInfo[clientId].isDeafened = Boolean(clientState.isDeafened);
      clientsInfo[clientId].isAFK = Boolean(clientState.isAFK);
      syncAllClients(io, clientsInfo);

      if (sfuClient && clientsInfo[clientId].hasJoinedChannel) {
        const ci = clientsInfo[clientId];
        const sfuRoomId = `${serverId}_${ci.voiceChannelId}`;
        const effectiveMuted = ci.isMuted || ci.isServerMuted;
        const effectiveDeafened = ci.isDeafened || ci.isServerDeafened;
        sfuClient.updateUserAudioState(sfuRoomId, ci.serverUserId, effectiveMuted, effectiveDeafened).catch((e) => {
          consola.error("Failed to update SFU audio state:", e);
        });
      }
    },

    'voice:stream:set': (streamID: string) => {
      if (!clientsInfo[clientId]) return;
      const wasInChannel = clientsInfo[clientId].hasJoinedChannel;
      const newJoinedState = streamID.length > 0;
      const serverUserId = clientsInfo[clientId].serverUserId;
      consola.info(`[Voice:stream:set] client=${clientId} user=${serverUserId} streamID="${streamID}" wasInChannel=${wasInChannel}`);

      if (!streamID && !wasInChannel) return;

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
      const prevJoinedState = wasInChannel;
      if (prevStreamID === streamID && prevJoinedState === newJoinedState) return;

      clientsInfo[clientId].streamID = streamID;
      clientsInfo[clientId].hasJoinedChannel = newJoinedState;
      if (!newJoinedState) {
        clientsInfo[clientId].voiceChannelId = "";
        clientsInfo[clientId].cameraEnabled = false;
        clientsInfo[clientId].cameraStreamID = "";
        clientsInfo[clientId].screenShareEnabled = false;
        clientsInfo[clientId].screenShareVideoStreamID = "";
        clientsInfo[clientId].screenShareAudioStreamID = "";
      }

      if (wasInChannel !== newJoinedState) {
        if (!wasInChannel && newJoinedState) {
          consola.info(`Client ${clientId} joined voice`);
        } else if (wasInChannel && !newJoinedState) {
          consola.info(`Client ${clientId} left voice`);
          if (sfuClient && serverUserId) sfuClient.untrackUserConnection(serverUserId);
        }
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
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

        const uniqueRoomId = `${serverId}_${roomId}`;
        consola.info(`[Voice:Step 3] Registering room ${uniqueRoomId} with SFU…`);
        await sfuClient.registerRoom(uniqueRoomId);
        consola.info(`[Voice:Step 3] Room registered: ${uniqueRoomId}`);

        const serverUserId = clientsInfo[clientId]?.serverUserId;
        consola.info(`[Voice:Step 4] Generating join token for client=${clientId} user=${serverUserId} room=${uniqueRoomId}`);
        const joinToken = sfuClient.generateClientJoinToken(uniqueRoomId, serverUserId);
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

    'voice:channel:joined': (hasJoined: boolean) => {
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

      const channelId = clientsInfo[clientId].voiceChannelId || "";
      const roomName = channelId ? voiceRoomName(serverId, channelId) : "";

      if (newJoinedState) {
        if (roomName) socket.join(roomName);
      } else {
        if (roomName) socket.leave(roomName);
      }

      clientsInfo[clientId].hasJoinedChannel = newJoinedState;
      if (!newJoinedState) {
        clientsInfo[clientId].isConnectedToVoice = false;
        clientsInfo[clientId].voiceChannelId = "";
        clientsInfo[clientId].cameraEnabled = false;
        clientsInfo[clientId].cameraStreamID = "";
        clientsInfo[clientId].screenShareEnabled = false;
        clientsInfo[clientId].screenShareVideoStreamID = "";
        clientsInfo[clientId].screenShareAudioStreamID = "";
      }

      syncAllClients(io, clientsInfo);

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

        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const targetUserId = payload.targetServerUserId.trim();

        if (targetUserId === auth.tokenPayload.serverUserId) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot disconnect yourself." });
          return;
        }

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
          const uniqueRoomId = `${serverId}_${targetClient.streamID}`;
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
