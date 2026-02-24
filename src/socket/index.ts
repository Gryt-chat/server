import consola from "consola";
import { Server, Socket } from "socket.io";
import { Clients } from "../types";
import { colors } from "../utils/colors";
import { SFUClient } from "../sfu/client";
import type { SFUPeerEvent, SFUSyncRoom } from "../sfu/client";
import { verifyAccessToken } from "../utils/jwt";
import { getUserByServerId, getServerConfig } from "../db/scylla";
import { syncAllClients, verifyClient, broadcastMemberList, countOtherSessions } from "./utils/clients";
import { sendInfo, sendServerDetails, setSocketRefs, broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate, broadcastServerUiUpdate } from "./utils/server";
import { getServerIdFromEnv } from "../utils/serverId";

import type { HandlerContext, EventHandlerMap } from "./handlers/types";
import { registerJoinHandlers } from "./handlers/join";
import { registerAdminHandlers } from "./handlers/admin";
import { registerChatHandlers } from "./handlers/chat";
import { registerVoiceHandlers } from "./handlers/voice";
import { registerMemberHandlers } from "./handlers/members";
import { registerDiagnosticsHandlers } from "./handlers/diagnostics";
import { registerVoiceLatencyHandlers } from "./handlers/voiceLatency";
import { registerReportHandlers } from "./handlers/reports";

export { broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate, broadcastServerUiUpdate };

const clientsInfo: Clients = {};

function voiceRoomName(serverId: string, channelId: string): string {
  return `voice:${serverId}:${channelId}`;
}

/**
 * Wire SFU peer_joined / peer_left / sync_response callbacks so the server
 * stays in 1:1 sync with the SFU about who is connected.
 * Call this once after the io server and sfuClient are created.
 */
export function setupSFUSync(io: Server, sfuClient: SFUClient): void {
  const serverId = getServerIdFromEnv();

  sfuClient.setCallbacks({
    onPeerJoined(ev: SFUPeerEvent) {
      sfuClient.trackUserConnection(ev.roomId, ev.userId);
    },

    onPeerLeft(ev: SFUPeerEvent) {
      sfuClient.untrackUserConnection(ev.userId);

      for (const [sid, ci] of Object.entries(clientsInfo)) {
        if (ci.serverUserId === ev.userId && ci.hasJoinedChannel) {
          const nickname = ci.nickname;
          const channelId = ci.voiceChannelId || "";
          const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
          ci.hasJoinedChannel = false;
          ci.voiceChannelId = "";
          ci.streamID = "";
          ci.isConnectedToVoice = false;
          ci.cameraEnabled = false;
          ci.cameraStreamID = "";
          ci.screenShareEnabled = false;
          ci.screenShareVideoStreamID = "";
          ci.screenShareAudioStreamID = "";

          const sock = io.sockets.sockets.get(sid);
          if (sock) {
            if (roomName) {
              sock.leave(roomName);
              sock.to(roomName).emit("voice:peer:left", { clientId: sid, nickname, channelId });
            }
            sock.emit("voice:channel:joined", false);
            sock.emit("voice:stream:set", "");
            sock.emit("voice:room:leave");
          }
        }
      }

      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    },

    onSyncResponse(rooms: SFUSyncRoom[]) {
      const sfuUsers = new Set<string>();
      const userToChannelId = new Map<string, string>();
      const serverPrefix = `${serverId}_`;
      for (const room of rooms) {
        const channelId = room.room_id.startsWith(serverPrefix)
          ? room.room_id.substring(serverPrefix.length)
          : room.room_id;
        for (const uid of room.user_ids) {
          sfuUsers.add(uid);
          userToChannelId.set(uid, channelId);
          sfuClient.trackUserConnection(room.room_id, uid);
        }
      }

      // Update voiceChannelId for active users from SFU state
      for (const [, ci] of Object.entries(clientsInfo)) {
        if (ci.hasJoinedChannel && sfuUsers.has(ci.serverUserId)) {
          const channelId = userToChannelId.get(ci.serverUserId);
          if (channelId && ci.voiceChannelId !== channelId) {
            ci.voiceChannelId = channelId;
          }
        }
      }

      // Disconnect any server-side users that the SFU no longer knows about
      for (const [sid, ci] of Object.entries(clientsInfo)) {
        if (ci.hasJoinedChannel && !sfuUsers.has(ci.serverUserId)) {
          consola.info(`[SFU-Sync] Stale voice user ${ci.serverUserId}, forcing disconnect`);
          const nickname = ci.nickname;
          const channelId = ci.voiceChannelId || "";
          const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
          ci.hasJoinedChannel = false;
          ci.voiceChannelId = "";
          ci.streamID = "";
          ci.isConnectedToVoice = false;
          ci.cameraEnabled = false;
          ci.cameraStreamID = "";
          ci.screenShareEnabled = false;
          ci.screenShareVideoStreamID = "";
          ci.screenShareAudioStreamID = "";
          sfuClient.untrackUserConnection(ci.serverUserId);

          const sock = io.sockets.sockets.get(sid);
          if (sock) {
            if (roomName) {
              sock.leave(roomName);
              sock.to(roomName).emit("voice:peer:left", { clientId: sid, nickname, channelId });
            }
            sock.emit("voice:channel:joined", false);
            sock.emit("voice:stream:set", "");
            sock.emit("voice:room:leave");
          }
        }
      }

      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    },
  });
}

function getClientIp(socket: Socket): string {
  const xf = socket.handshake.headers["x-forwarded-for"] as string | string[] | undefined;
  if (Array.isArray(xf) && xf.length > 0) return xf[0];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return (socket.handshake.address as string) || "unknown";
}

async function getTokenVersionForServer(): Promise<number> {
  const cfg = await getServerConfig();
  return cfg?.token_version ?? 0;
}

export function socketHandler(io: Server, socket: Socket, sfuClient: SFUClient | null) {
  const clientId = socket.id;
  const serverId = getServerIdFromEnv();
  const verboseLogs = (process.env.NODE_ENV || "").toLowerCase() !== "production";

  // Keep module-level refs for REST-triggered broadcasts
  setSocketRefs(io, serverId, clientsInfo);

  consola.info(`Client ${clientId} connected from ${socket.handshake.address}`);

  if (verboseLogs) {
    const originalEmit = socket.emit;
    socket.emit = function (event: string, ...args: unknown[]) {
      console.log(`SERVER EMIT ${clientId}:`, event, args.length > 0 ? args : "");
      return originalEmit.call(this, event, ...args);
    };
    socket.onAny((event: string, ...args: unknown[]) => {
      console.log(`SERVER RECV ${clientId}:`, event, args.length > 0 ? args : "");
    });
  }

  // Initialize client
  clientsInfo[clientId] = {
    serverUserId: `temp_${clientId}`,
    nickname: "User",
    isMuted: false,
    isDeafened: false,
    color: colors[Math.floor(Math.random() * colors.length)],
    streamID: "",
    hasJoinedChannel: false,
    voiceChannelId: "",
    isConnectedToVoice: false,
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
  };

  // Build handler context
  const ctx: HandlerContext = {
    io,
    socket,
    clientId,
    serverId,
    clientsInfo,
    sfuClient,
    getClientIp: () => getClientIp(socket),
  };

  // Collect all event handlers from domain modules
  const allHandlers: EventHandlerMap = {
    ...registerJoinHandlers(ctx),
    ...registerAdminHandlers(ctx),
    ...registerChatHandlers(ctx),
    ...registerVoiceHandlers(ctx),
    ...registerMemberHandlers(ctx),
    ...registerReportHandlers(ctx),
    ...registerDiagnosticsHandlers(ctx),
    ...registerVoiceLatencyHandlers(ctx),
  };

  // ── Base socket events ───────────────────────────────────────

  socket.on("error", (error) => consola.error(`Socket error from ${clientId}:`, error));

  socket.on("server:info", () => sendInfo(socket, clientsInfo, serverId));

  socket.on("disconnect", (reason) => {
    consola.info(`Client disconnected: ${clientId} (${reason})`);
    const clientInfo = clientsInfo[clientId];
    if (clientInfo?.serverUserId && sfuClient) {
      sfuClient.untrackUserConnection(clientInfo.serverUserId);
    }
    if (clientInfo?.hasJoinedChannel) {
      const channelId = clientInfo.voiceChannelId || "";
      const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
      if (roomName) {
        socket.to(roomName).emit("voice:peer:left", {
          clientId,
          nickname: clientInfo.nickname,
          channelId,
        });
      }
    }
    const wasRegistered = clientInfo?.serverUserId && !clientInfo.serverUserId.startsWith("temp_");
    delete clientsInfo[clientId];
    if (wasRegistered) {
      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    }
  });

  // Register all domain handlers
  for (const [event, handler] of Object.entries(allHandlers)) {
    socket.on(event, handler);
  }

  // ── Session restoration (access token on connect) ────────────

  sendInfo(socket, clientsInfo, serverId);
  verifyClient(socket);

  const clientAccessToken = socket.handshake.auth?.accessToken;
  if (clientAccessToken) {
    const tokenPayload = verifyAccessToken(clientAccessToken);
    if (tokenPayload && tokenPayload.serverHost === socket.handshake.headers.host) {
      (async () => {
        try {
          const currentVersion = await getTokenVersionForServer();
          if ((tokenPayload.tokenVersion ?? 0) !== currentVersion) {
            socket.emit("token:revoked", { reason: "token_version_mismatch", message: "Session stale. Please rejoin." });
            return;
          }

          const userExists = await getUserByServerId(tokenPayload.serverUserId);
          if (userExists && userExists.is_active) {
            clientsInfo[clientId].accessToken = clientAccessToken;
            clientsInfo[clientId].grytUserId = tokenPayload.grytUserId;
            clientsInfo[clientId].serverUserId = tokenPayload.serverUserId;
            clientsInfo[clientId].nickname = tokenPayload.nickname;
            const otherCount = countOtherSessions(clientsInfo, clientId, tokenPayload.grytUserId);
            consola.info(
              `Restored session: ${tokenPayload.nickname} (${tokenPayload.serverUserId})` +
              (otherCount > 0 ? ` — ${otherCount} other session(s) active` : ""),
            );

            syncAllClients(io, clientsInfo);
            broadcastMemberList(io, clientsInfo, serverId);
            sendServerDetails(socket, clientsInfo, serverId).catch(() => {});

            try {
              const cfg = await getServerConfig();
              if (cfg?.owner_gryt_user_id === tokenPayload.grytUserId && !cfg.is_configured) {
                socket.emit("server:setup_required", {
                  serverId,
                  settings: {
                    displayName: cfg.display_name || process.env.SERVER_NAME || "Unknown Server",
                    description: cfg.description || process.env.SERVER_DESCRIPTION || "A Gryt server",
                    iconUrl: cfg.icon_url || null,
                    isConfigured: !!cfg.is_configured,
                  },
                });
              }
            } catch { /* ignore */ }
          } else {
            socket.emit("token:revoked", { reason: "membership_required", message: "Please rejoin." });
          }
        } catch (error) {
          consola.error(`Error restoring session for ${clientId}:`, error);
          socket.emit("token:invalid", "Database error. Please rejoin.");
        }
      })();
    }
  }

}
