import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, setUserWorn, updateUserNickname } from "../../db";
import { hasPermission } from "../../services/permissions";
import { buildMemberList, syncAllClients, broadcastMemberList } from "../utils/clients";
import { socketMay } from "../utils/standing";
import { looksLikeABotName } from "../../auth/identity";
import { readWornUpdate } from "../../utils/wornString";
import { normaliseActivity } from "../../utils/activityText";

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

    /**
     * What this person says they are doing, in their own words (GRYT-929).
     *
     * No permission of its own. It says nothing to anybody who cannot already
     * see the member list, and gating it behind a role would mean a status that
     * silently does nothing for most people — a moderator takes it down with
     * the tools they already have for a nickname.
     *
     * Held on the connection rather than stored, so it stops being true when
     * they close the app. That means it does not survive a reconnect and the
     * client re-sends it on join, the same as voice state.
     *
     * Clearing goes through the same door: an empty string, or one that is
     * only spaces, normalises to null and takes the status down.
     */
    'presence:activity': async (data: { activity?: unknown }) => {
      const info = clientsInfo[clientId];
      if (!info) return;
      // Not for a socket that has not said who it is. `temp_` clients are
      // filtered out of the member list anyway, so this would be a status
      // nobody could see attached to nobody in particular.
      if (!info.serverUserId || info.serverUserId.startsWith("temp_")) return;

      const activity = normaliseActivity(data?.activity);
      if (info.activity === (activity ?? undefined)) return;

      info.activity = activity ?? undefined;
      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    },

    'profile:update': async (data: { nickname?: string; avatarWorn?: string | null }) => {
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
          if (looksLikeABotName(nickname)) {
            socket.emit("profile:error", 'Names that start with "bot" are reserved.');
            return;
          }

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

        // The look, which rides along with the nickname because that is what it
        // is: a second thing about how somebody appears here, set from the same
        // screen and synced by the same button.
        //
        // Gated on nothing. `change_nickname` exists because a name is what
        // everybody reads and a name can be abusive; a hat cannot, and the
        // options are a fixed registry rather than free text. A member barred
        // from renaming should still be able to choose a hat.
        const wornUpdate = readWornUpdate(data?.avatarWorn);
        if (wornUpdate.kind === "invalid") {
          socket.emit("profile:error", "That avatar could not be read.");
          return;
        }
        if (wornUpdate.kind === "set") await setUserWorn(serverUserId, wornUpdate.worn);
        if (wornUpdate.kind === "clear") await setUserWorn(serverUserId, null);

        const user = await getUserByServerId(serverUserId);
        socket.emit("profile:updated", {
          nickname: user?.nickname ?? clientsInfo[clientId].nickname,
          avatarFileId: user?.avatar_file_id ?? null,
          avatarWorn: user?.avatar_worn ?? null,
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
            avatarWorn: user?.avatar_worn ?? null,
          });
        }
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (err) {
        consola.error("avatar:updated failed", err);
      }
    },
  };
}
