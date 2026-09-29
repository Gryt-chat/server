import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, setUserCard, setUserWorn, updateUserNickname } from "../../db";
import { hasPermission } from "../../services/permissions";
import { buildMemberList, syncAllClients, broadcastMemberList } from "../utils/clients";
import { socketMay } from "../utils/standing";
import { looksLikeABotName } from "../../auth/identity";
import { readWornUpdate } from "../../utils/wornString";
import { normaliseActivity } from "../../utils/activityText";
import { normaliseRichActivity, sameRichActivity } from "../../utils/richActivity";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { cardFields, readCardUpdate, setsCardText } from "../../utils/memberCard";

/* Every accepted change fans out to the whole server, so it is bounded like the
   chat events. Ten in ten seconds is well past anything done by hand. */
const RL_ACTIVITY: RateLimitRule = { limit: 10, windowMs: 10_000, banMs: 30_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 2_000 };

export function registerMemberHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, getClientIp } = ctx;

  return {
    // Gated on being a verified member rather than on a role, which is what the
    // broadcast copy of this list already assumes.
    'members:fetch': async () => {
      try {
        const requester = clientsInfo[clientId];
        if (!requester?.grytUserId) {
          // Quietly: the client fetches this before the session is restored, so
          // an error here showed "Failed to join server" on every page load.
          return;
        }

        if (!(await socketMay(clientsInfo, clientId, "view_members"))) {
          // Quiet, like the gate above: a role that may not see the list is not
          // worth an error toast on every connect.
          return;
        }

        const members = await buildMemberList(clientsInfo);

        socket.emit("members:list", members);
      } catch (err) {
        consola.error("members:fetch failed", err);
        socket.emit("members:error", "Failed to fetch member list");
      }
    },

    /** Held on the connection, not stored, so it stops being true when the app
        closes and the client re-sends it on join. Empty clears it. */
    'presence:activity': async (data: { activity?: unknown; rich?: unknown }) => {
      const info = clientsInfo[clientId];
      if (!info) return;
      // `temp_` clients are filtered out of the member list, so this would be a
      // status nobody can see on nobody in particular.
      if (!info.serverUserId || info.serverUserId.startsWith("temp_")) return;

      const rich = normaliseRichActivity(data?.rich);
      // The line is what every client reads. With no line sent, the card's name is it.
      const activity =
        data?.activity === undefined && rich ? normaliseActivity(rich.name) : normaliseActivity(data?.activity);
      const card = activity === null ? undefined : rich ?? undefined;

      /* Setting one is what fans out, so only that is limited or scored. A clear
         always goes through, or a ban is a status you cannot take off. */
      if (activity !== null) {
        const rl = checkRateLimit("presence:activity", info.serverUserId, getClientIp(), RL_ACTIVITY);
        if (!rl.allowed) {
          socket.emit("server:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs });
          return;
        }
      }

      /* On the way up only, like turning a camera off: losing the permission
         must not leave somebody wearing a status they cannot remove. */
      if (activity !== null && !(await socketMay(clientsInfo, clientId, "set_activity"))) {
        socket.emit("server:error", {
          error: "forbidden",
          message: "You cannot set a status on this server.",
          permission: "set_activity",
        });
        return;
      }
      if (info.activity === (activity ?? undefined) && sameRichActivity(info.richActivity, card)) return;

      info.activity = activity ?? undefined;
      info.richActivity = card;
      syncAllClients(io, clientsInfo);
      broadcastMemberList(io, clientsInfo, serverId);
    },

    'profile:update': async (data: {
      nickname?: string;
      avatarWorn?: string | null;
      cardStyle?: unknown;
      bio?: string | null;
      pronouns?: string | null;
      statusLine?: string | null;
    }) => {
      if (!clientsInfo[clientId]) return;
      const serverUserId = clientsInfo[clientId].serverUserId;
      if (!serverUserId || serverUserId.startsWith("temp_")) {
        socket.emit("profile:error", "Not authenticated");
        return;
      }

      try {
        // Checked before anything is written, so a refusal leaves the whole update unapplied.
        const card = readCardUpdate(data as Record<string, unknown>);
        if (Object.keys(card).length > 0) {
          const rl = checkRateLimit("profile:card", serverUserId, getClientIp(), RL_ACTIVITY);
          if (!rl.allowed) {
            socket.emit("server:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs });
            return;
          }
          // Free text everybody reads, so the status permission. Clearing never needs it.
          if (setsCardText(card) && !(await socketMay(clientsInfo, clientId, "set_activity"))) {
            socket.emit("profile:error", "You cannot set a bio, pronouns or a status line on this server.");
            return;
          }
        }

        const nickname = typeof data?.nickname === "string"
          ? data.nickname.trim().substring(0, 20)
          : undefined;

        if (nickname !== undefined && nickname.length > 0) {
          // Only when a name is being set: this event is also how a client asks
          // for its own profile back.
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

        // Gated on nothing: `change_nickname` exists because a name is free text
        // that can be abusive, and a hat is a fixed registry.
        const wornUpdate = readWornUpdate(data?.avatarWorn);
        if (wornUpdate.kind === "invalid") {
          socket.emit("profile:error", "That avatar could not be read.");
          return;
        }
        if (wornUpdate.kind === "set") await setUserWorn(serverUserId, wornUpdate.worn);
        if (wornUpdate.kind === "clear") await setUserWorn(serverUserId, null);

        if (Object.keys(card).length > 0) {
          await setUserCard(serverUserId, {
            card_style: card.cardStyle,
            bio: card.bio,
            pronouns: card.pronouns,
            status_line: card.statusLine,
          });
        }

        const user = await getUserByServerId(serverUserId);
        socket.emit("profile:updated", {
          nickname: user?.nickname ?? clientsInfo[clientId].nickname,
          avatarFileId: user?.avatar_file_id ?? null,
          avatarWorn: user?.avatar_worn ?? null,
          ...(user ? cardFields(user) : {}),
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
            ...(user ? cardFields(user) : {}),
          });
        }
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (err) {
        consola.error("avatar:updated failed", err);
      }
    },
  };
}
