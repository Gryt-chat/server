import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import type { Clients } from "../../types";
import { getAllRegisteredUsers, listServerRoles } from "../../db/scylla";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import { updateUserNickname, getUserByServerId } from "../../db/users";

export function registerMemberHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo } = ctx;

  return {
    'members:fetch': async () => {
      try {
        const registeredUsers = await getAllRegisteredUsers();
        const roleRows = await listServerRoles();
        const roleMap = new Map(roleRows.map((r) => [r.server_user_id, r.role]));

        const onlineUsers = new Map<string, Clients[string]>();
        Object.values(clientsInfo).forEach((client) => {
          if (client.serverUserId && !client.serverUserId.startsWith("temp_")) {
            onlineUsers.set(client.serverUserId, client);
          }
        });

        const members = registeredUsers
          .filter((u) => u.is_active)
          .map((user) => {
            const onlineClient = onlineUsers.get(user.server_user_id);
            let status: "online" | "in_voice" | "afk" | "offline" = "offline";
            if (onlineClient) {
              if (onlineClient.isAFK) status = "afk";
              else if (onlineClient.hasJoinedChannel) status = "in_voice";
              else status = "online";
            }
            return {
              serverUserId: user.server_user_id,
              nickname: user.nickname,
              avatarFileId: user.avatar_file_id || null,
              role: roleMap.get(user.server_user_id) || "member",
              status,
              lastSeen: user.last_seen,
              isMuted: onlineClient?.isMuted || false,
              isDeafened: onlineClient?.isDeafened || false,
              isServerMuted: onlineClient?.isServerMuted || false,
              isServerDeafened: onlineClient?.isServerDeafened || false,
              color: onlineClient?.color || "#666666",
              isConnectedToVoice: onlineClient?.isConnectedToVoice || false,
              hasJoinedChannel: onlineClient?.hasJoinedChannel || false,
              voiceChannelId: onlineClient?.voiceChannelId || "",
              streamID: onlineClient?.streamID || "",
            };
          });

        socket.emit("members:list", members);
      } catch (err) {
        consola.error("members:fetch failed", err);
        socket.emit("members:error", "Failed to fetch member list");
      }
    },

    'profile:update': async (data: { nickname?: string }) => {
      if (!clientsInfo[clientId]) return;
      const serverUserId = clientsInfo[clientId].serverUserId;
      if (!serverUserId || serverUserId.startsWith("temp_")) {
        socket.emit("profile:error", "Not authenticated");
        return;
      }

      try {
        const nickname = typeof data?.nickname === "string"
          ? data.nickname.trim().substring(0, 20)
          : undefined;

        if (nickname !== undefined && nickname.length > 0) {
          await updateUserNickname(serverUserId, nickname);
          clientsInfo[clientId].nickname = nickname;
        }

        const user = await getUserByServerId(serverUserId);
        socket.emit("profile:updated", {
          nickname: user?.nickname ?? clientsInfo[clientId].nickname,
          avatarFileId: user?.avatar_file_id ?? null,
        });

        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (err) {
        consola.error("profile:update failed", err);
        socket.emit("profile:error", "Failed to update profile");
      }
    },

    'avatar:updated': async () => {
      try {
        const serverUserId = clientsInfo[clientId]?.serverUserId;
        if (serverUserId && !serverUserId.startsWith("temp_")) {
          const user = await getUserByServerId(serverUserId);
          socket.emit("profile:updated", {
            nickname: user?.nickname ?? clientsInfo[clientId]?.nickname,
            avatarFileId: user?.avatar_file_id ?? null,
          });
        }
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (err) {
        consola.error("avatar:updated failed", err);
      }
    },
  };
}
