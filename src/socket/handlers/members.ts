import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, updateUserNickname } from "../../db";
import { buildMemberList, syncAllClients, broadcastMemberList } from "../utils/clients";

export function registerMemberHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo } = ctx;

  return {
    // Was open to any socket, authenticated or not — the full member list,
    // nicknames and roles included, for anyone who could reach the port. It is
    // gated on being a verified member rather than on a role, since that is
    // what the broadcast copy of this list already assumes.
    'members:fetch': async () => {
      try {
        const requester = clientsInfo[clientId];
        if (!requester?.grytUserId) {
          // Refuse quietly. The client fetches this optimistically the moment a
          // socket connects, before the session has been restored, so answering
          // with server:error made every page load show "Failed to join server"
          // — the gate is here to withhold the data, not to complain about a
          // call the client is supposed to make. It asks again after joining.
          return;
        }

        const members = await buildMemberList(clientsInfo);

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
