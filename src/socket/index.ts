import consola from "consola";
import { Server, Socket } from "socket.io";
import { Clients } from "../types";
import { colors } from "../utils/colors";
import { SFUClient } from "../sfu/client";
import type { SFUPeerEvent, SFUSyncRoom } from "../sfu/client";
import { verifyAccessToken } from "../utils/jwt";
import { getUserByServerId, getServerConfig } from "../db";
import { syncAllClients, verifyClient, broadcastMemberList, countOtherSessions } from "./utils/clients";
import { sendInfo, sendServerDetails, setSocketRefs, broadcastChatNew, broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate, broadcastServerUiUpdate } from "./utils/server";
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
import { registerTypingHandlers } from "./handlers/typing";

export { broadcastChatNew, broadcastCustomEmojisUpdate, broadcastEmojiQueueUpdate, broadcastServerUiUpdate };

const clientsInfo: Clients = {};

function voiceRoomName(serverId: string, channelId: string): string {
  return `voice:${serverId}:${channelId}`;
}

// Grace period for voice state during transient Socket.IO disconnects (e.g.
// Cloudflare Tunnel WebSocket resets). Instead of immediately tearing down
// voice state, we stash it for VOICE_GRACE_MS and restore it if the same user
// reconnects within the window.
const VOICE_GRACE_MS = 15_000;

interface PendingVoiceCleanup {
  timer: ReturnType<typeof setTimeout>;
  voiceChannelId: string;
  streamID: string;
  nickname: string;
  screenShareEnabled: boolean;
  screenShareVideoStreamID: string;
  screenShareAudioStreamID: string;
  cameraEnabled: boolean;
  cameraStreamID: string;
  isMuted: boolean;
  isDeafened: boolean;
}

const pendingVoiceCleanup = new Map<string, PendingVoiceCleanup>();

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
      const RECONNECT_GRACE_MS = 10_000;
      const tracked = sfuClient.getTrackedUser(ev.userId);

      if (tracked && (Date.now() - tracked.connectedAt) < RECONNECT_GRACE_MS) {
        consola.info(
          `[SFU-Sync] Ignoring stale peer_left for ${ev.userId} — ` +
          `reconnected ${Date.now() - tracked.connectedAt}ms ago`,
        );
        return;
      }

      sfuClient.untrackUserConnection(ev.userId);

      let changed = false;
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
          changed = true;
        }
      }

      if (changed) {
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
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
    ...registerTypingHandlers(ctx),
  };

  // ── Base socket events ───────────────────────────────────────

  socket.on("error", (error) => consola.error(`Socket error from ${clientId}:`, error));

  socket.on("server:info", () => sendInfo(socket, clientsInfo, serverId));

  socket.on("disconnect", (reason) => {
    consola.info(`Client disconnected: ${clientId} (${reason})`);
    const clientInfo = clientsInfo[clientId];
    const serverUserId = clientInfo?.serverUserId ?? "";
    const wasRegistered = serverUserId && !serverUserId.startsWith("temp_");
    const hadVoice = clientInfo?.hasJoinedChannel ?? false;

    // On transient transport drops (typical for Cloudflare Tunnel), defer voice
    // cleanup so the user can reconnect without a full SFU teardown.
    if (reason === "transport close" && hadVoice && wasRegistered) {
      consola.info(`[Voice:Grace] Stashing voice state for ${serverUserId} (${VOICE_GRACE_MS}ms grace)`);

      const timer = setTimeout(() => {
        pendingVoiceCleanup.delete(serverUserId);
        consola.info(`[Voice:Grace] Grace expired for ${serverUserId} — cleaning up`);

        if (sfuClient) sfuClient.untrackUserConnection(serverUserId);

        const channelId = clientInfo.voiceChannelId || "";
        const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
        if (roomName) {
          io.to(roomName).emit("voice:peer:left", {
            clientId,
            nickname: clientInfo.nickname,
            channelId,
          });
        }

        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }, VOICE_GRACE_MS);

      pendingVoiceCleanup.set(serverUserId, {
        timer,
        voiceChannelId: clientInfo.voiceChannelId || "",
        streamID: clientInfo.streamID || "",
        nickname: clientInfo.nickname,
        screenShareEnabled: clientInfo.screenShareEnabled,
        screenShareVideoStreamID: clientInfo.screenShareVideoStreamID,
        screenShareAudioStreamID: clientInfo.screenShareAudioStreamID,
        cameraEnabled: clientInfo.cameraEnabled,
        cameraStreamID: clientInfo.cameraStreamID,
        isMuted: clientInfo.isMuted,
        isDeafened: clientInfo.isDeafened,
      });

      delete clientsInfo[clientId];
      if (wasRegistered) {
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      }
      return;
    }

    // Immediate cleanup for intentional disconnects and other reasons
    if (serverUserId && sfuClient) {
      sfuClient.untrackUserConnection(serverUserId);
    }
    if (hadVoice) {
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

            // Restore voice state if the user reconnected within the grace period
            const pending = pendingVoiceCleanup.get(tokenPayload.serverUserId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingVoiceCleanup.delete(tokenPayload.serverUserId);
              consola.info(`[Voice:Grace] Restored voice state for ${tokenPayload.nickname} (${tokenPayload.serverUserId})`);

              clientsInfo[clientId].hasJoinedChannel = true;
              clientsInfo[clientId].voiceChannelId = pending.voiceChannelId;
              clientsInfo[clientId].streamID = pending.streamID;
              clientsInfo[clientId].isConnectedToVoice = true;
              clientsInfo[clientId].screenShareEnabled = pending.screenShareEnabled;
              clientsInfo[clientId].screenShareVideoStreamID = pending.screenShareVideoStreamID;
              clientsInfo[clientId].screenShareAudioStreamID = pending.screenShareAudioStreamID;
              clientsInfo[clientId].cameraEnabled = pending.cameraEnabled;
              clientsInfo[clientId].cameraStreamID = pending.cameraStreamID;
              clientsInfo[clientId].isMuted = pending.isMuted;
              clientsInfo[clientId].isDeafened = pending.isDeafened;

              const roomName = pending.voiceChannelId
                ? voiceRoomName(serverId, pending.voiceChannelId)
                : "";
              if (roomName) socket.join(roomName);

              socket.emit("voice:state:restored", {
                channelId: pending.voiceChannelId,
                streamID: pending.streamID,
              });
            }

            const otherCount = countOtherSessions(clientsInfo, clientId, tokenPayload.grytUserId);
            consola.info(
              `Restored session: ${tokenPayload.nickname} (${tokenPayload.serverUserId})` +
              (otherCount > 0 ? ` — ${otherCount} other session(s) active` : ""),
            );

            verifyClient(socket);
            syncAllClients(io, clientsInfo);
            broadcastMemberList(io, clientsInfo, serverId);
            sendServerDetails(socket, clientsInfo, serverId).catch((e) => consola.warn("sendServerDetails failed", e));

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
