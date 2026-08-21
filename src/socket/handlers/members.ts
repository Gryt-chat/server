import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, updateUserNickname } from "../../db";
import { hasPermission } from "../../services/permissions";
import { buildMemberList, syncAllClients, broadcastMemberList } from "../utils/clients";
import { socketMay } from "../utils/standing";

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

        if (!(await socketMay(clientsInfo, clientId, "view_members"))) {
          // Quiet, like the join gate above it. The client asks for this
          // optimistically on every connect, and a role that may not see the
          // list is not a state worth an error toast on every page load.
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
          // Only checked when a name is actually being set. This event is also
          // the client's way of asking for its own profile back, and refusing
          // that would break the read for everybody who cannot write.
          const mayRename = await hasPermission(
            serverUserId,
            "change_nickname",
            clientsInfo[clientId].grytUserId,
          );
          if (!mayRename) {
            socket.emit("profile:error", "You do not have permission to change your nickname here.");
            return;
          }
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
