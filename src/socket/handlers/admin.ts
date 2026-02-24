import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import { broadcastServerUiUpdate, sendEmojiQueueStateToSocket } from "../utils/server";
import { VALID_CENSOR_STYLES, type CensorStyle } from "../../utils/profanityFilter";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import {
  getServerConfig,
  createServerConfigIfNotExists,
  updateServerConfig,
  DEFAULT_AVATAR_MAX_BYTES,
  DEFAULT_EMOJI_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
  createServerInvite,
  listServerInvites,
  revokeServerInvite,
  getServerRole,
  setServerRole,
  listServerRoles,
  insertServerAudit,
  listServerAudit,
  banUser,
  unbanUser,
  listBans,
} from "../../db/scylla";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { registerAdminChannelHandlers } from "./adminChannels";

const RL_SETTINGS: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 20, scoreDecayMs: 3_000 };
const RL_INVITE: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 5_000 };
const RL_MODERATION: RateLimitRule = { limit: 15, windowMs: 60_000, scorePerAction: 2, maxScore: 10, scoreDecayMs: 5_000 };

function rlCheck(event: string, ctx: HandlerContext, rule: RateLimitRule) {
  const ip = ctx.getClientIp();
  const userId = ctx.clientsInfo[ctx.clientId]?.serverUserId;
  return checkRateLimit(event, userId, ip, rule);
}

function emitRateLimited(ctx: HandlerContext, rl: { retryAfterMs?: number }) {
  ctx.socket.emit("server:error", {
    error: "rate_limited",
    retryAfterMs: rl.retryAfterMs,
    message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
  });
}

export function registerAdminHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient } = ctx;

  return {
    'server:settings:get': async () => {
      try {
        const client = clientsInfo[clientId];
        if (!client?.grytUserId) {
          socket.emit("server:error", { error: "join_required", message: "Please join the server first." });
          return;
        }

        let cfg = await getServerConfig();
        if (!cfg) cfg = (await createServerConfigIfNotExists()).config;

        const isOwner = !!(cfg.owner_gryt_user_id && cfg.owner_gryt_user_id === client.grytUserId);
        socket.emit("server:settings", {
          serverId,
          isOwner,
          isConfigured: !!cfg.is_configured,
          displayName: cfg.display_name || process.env.SERVER_NAME || "Unknown Server",
          description: cfg.description || process.env.SERVER_DESCRIPTION || "A Gryt server",
          iconUrl: cfg.icon_url || null,
          avatarMaxBytes: cfg.avatar_max_bytes ?? DEFAULT_AVATAR_MAX_BYTES,
          uploadMaxBytes: cfg.upload_max_bytes ?? DEFAULT_UPLOAD_MAX_BYTES,
          emojiMaxBytes: cfg.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES,
          profanityMode: cfg.profanity_mode ?? "censor",
          profanityCensorStyle: cfg.profanity_censor_style ?? "emoji",
        });
      } catch (e) {
        consola.error("server:settings:get failed", e);
        socket.emit("server:error", { error: "settings_failed", message: "Failed to load settings." });
      }
    },

    "server:emojiQueue:get": async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;
        sendEmojiQueueStateToSocket(socket);
      } catch (e) {
        consola.error("server:emojiQueue:get failed", e);
        socket.emit("server:error", { error: "emoji_queue_failed", message: "Failed to load emoji queue." });
      }
    },

    'server:settings:update': async (payload: {
      accessToken: string;
      displayName?: string;
      description?: string;
      iconUrl?: string | null;
      avatarMaxBytes?: number | null;
      uploadMaxBytes?: number | null;
      emojiMaxBytes?: number | null;
      profanityMode?: string;
      profanityCensorStyle?: string;
    }) => {
      try {
        const rl = rlCheck("server:settings:update", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { requiredRole: "owner" });
        if (!auth) return;

        const displayName = typeof payload.displayName === "string" ? payload.displayName.trim().slice(0, 80) : undefined;
        const description = typeof payload.description === "string" ? payload.description.trim().slice(0, 300) : undefined;
        const iconUrl = typeof payload.iconUrl === "string" ? payload.iconUrl.trim().slice(0, 500) : payload.iconUrl === null ? null : undefined;

        const clampBytes = (v: number | null | undefined, min: number, max: number): number | null | undefined => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          const n = typeof v === "number" ? v : Number(v);
          if (!Number.isFinite(n)) return undefined;
          return Math.max(min, Math.min(max, Math.floor(n)));
        };

        const avatarMaxBytes = clampBytes(payload.avatarMaxBytes, 256 * 1024, 50 * 1024 * 1024);
        const uploadMaxBytes = clampBytes(payload.uploadMaxBytes, 256 * 1024, 200 * 1024 * 1024);
        const emojiMaxBytes = clampBytes(payload.emojiMaxBytes, 64 * 1024, 200 * 1024 * 1024);

        const validProfanityModes = ["off", "flag", "censor", "block"] as const;
        const profanityMode = typeof payload.profanityMode === "string" && validProfanityModes.includes(payload.profanityMode as typeof validProfanityModes[number])
          ? payload.profanityMode as typeof validProfanityModes[number]
          : undefined;

        const profanityCensorStyle: CensorStyle | undefined =
          typeof payload.profanityCensorStyle === "string" && VALID_CENSOR_STYLES.includes(payload.profanityCensorStyle as CensorStyle)
            ? payload.profanityCensorStyle as CensorStyle
            : undefined;

        const updated = await updateServerConfig({
          displayName: displayName === undefined ? undefined : (displayName!.length > 0 ? displayName : null),
          description: description === undefined ? undefined : (description!.length > 0 ? description : null),
          iconUrl,
          isConfigured: true,
          avatarMaxBytes,
          uploadMaxBytes,
          emojiMaxBytes,
          profanityMode,
          profanityCensorStyle,
        });

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "settings_update",
          target: null,
          meta: {
            displayName: displayName ?? null,
            description: description ?? null,
          },
        }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("server:settings", {
          serverId,
          isOwner: true,
          isConfigured: !!updated.is_configured,
          displayName: updated.display_name || process.env.SERVER_NAME || "Unknown Server",
          description: updated.description || process.env.SERVER_DESCRIPTION || "A Gryt server",
          iconUrl: updated.icon_url || null,
          avatarMaxBytes: updated.avatar_max_bytes ?? DEFAULT_AVATAR_MAX_BYTES,
          uploadMaxBytes: updated.upload_max_bytes ?? DEFAULT_UPLOAD_MAX_BYTES,
          emojiMaxBytes: updated.emoji_max_bytes ?? DEFAULT_EMOJI_MAX_BYTES,
          profanityMode: updated.profanity_mode ?? "censor",
          profanityCensorStyle: updated.profanity_censor_style ?? "emoji",
        });
        broadcastServerUiUpdate("settings");
      } catch (e) {
        consola.error("server:settings:update failed", e);
        socket.emit("server:error", { error: "settings_update_failed", message: "Failed to update settings." });
      }
    },

    // ── Invites ──────────────────────────────────────────────────

    'server:invites:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;
        const invites = await listServerInvites();
        socket.emit("server:invites", {
          serverId,
          invites: invites
            .map((i) => ({ code: i.code, createdAt: i.created_at, expiresAt: i.expires_at, maxUses: i.max_uses, usesRemaining: i.uses_remaining, usesConsumed: i.uses_consumed, revoked: i.revoked, note: i.note }))
            .sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0)),
        });
      } catch (e) {
        consola.error("server:invites:list failed", e);
        socket.emit("server:error", { error: "invites_failed", message: "Failed to list invites." });
      }
    },

    'server:invites:create': async (payload: { accessToken: string; infinite?: boolean; maxUses?: number; expiresInHours?: number; note?: string | null }) => {
      try {
        const rl = rlCheck("server:invites:create", ctx, RL_INVITE);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const infinite = payload.infinite === true;
        const maxUses = infinite ? undefined : (typeof payload.maxUses === "number" ? payload.maxUses : 1);
        const expiresInHours = typeof payload.expiresInHours === "number" ? payload.expiresInHours : undefined;
        const expiresAt = typeof expiresInHours === "number" && expiresInHours > 0
          ? new Date(Date.now() + Math.min(expiresInHours, 24 * 365) * 3_600_000)
          : null;

        const created = await createServerInvite(auth.tokenPayload.serverUserId, { infinite, maxUses, expiresAt, note: payload.note ?? null });
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "invite_create", target: created.code, meta: { infinite, maxUses: created.max_uses, expiresAt: created.expires_at } }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("server:invite:created", {
          serverId,
          invite: { code: created.code, createdAt: created.created_at, expiresAt: created.expires_at, maxUses: created.max_uses, usesRemaining: created.uses_remaining, usesConsumed: created.uses_consumed, revoked: created.revoked, note: created.note },
        });
      } catch (e) {
        consola.error("server:invites:create failed", e);
        socket.emit("server:error", { error: "invite_create_failed", message: "Failed to create invite." });
      }
    },

    'server:invites:revoke': async (payload: { accessToken: string; code: string }) => {
      try {
        const rl = rlCheck("server:invites:revoke", ctx, RL_INVITE);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.code !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "code is required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const code = payload.code.trim();
        await revokeServerInvite(code, true);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "invite_revoke", target: code, meta: { revoked: true } }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:invite:revoked", { serverId, code, revoked: true });
      } catch (e) {
        consola.error("server:invites:revoke failed", e);
        socket.emit("server:error", { error: "invite_revoke_failed", message: "Failed to revoke invite." });
      }
    },

    // ── Roles ────────────────────────────────────────────────────

    'server:roles:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;
        const roles = await listServerRoles();
        socket.emit("server:roles", { serverId, roles: roles.map((r) => ({ serverUserId: r.server_user_id, role: r.role, updatedAt: r.updated_at })) });
      } catch (e) {
        consola.error("server:roles:list failed", e);
        socket.emit("server:error", { error: "roles_failed", message: "Failed to list roles." });
      }
    },

    'server:roles:set': async (payload: { accessToken: string; serverUserId: string; role: string }) => {
      try {
        const rl = rlCheck("server:roles:set", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.serverUserId !== "string" || typeof payload.role !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "serverUserId and role required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "owner" });
        if (!auth) return;

        const nextRole = payload.role.toLowerCase();
        if (nextRole === "owner") {
          socket.emit("server:error", { error: "forbidden", message: "Owner role cannot be reassigned." });
          return;
        }
        if (payload.serverUserId.trim() === auth.tokenPayload.serverUserId) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot change your own role." });
          return;
        }

        const targetId = payload.serverUserId.trim();
        await setServerRole(targetId, nextRole === "admin" || nextRole === "mod" ? nextRole : "member");
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "role_set", target: targetId, meta: { role: nextRole } }).catch((e) => consola.warn("audit log write failed", e));
        io.to("verifiedClients").emit("server:role:updated", { serverId, serverUserId: targetId, role: nextRole });
      } catch (e) {
        consola.error("server:roles:set failed", e);
        socket.emit("server:error", { error: "roles_update_failed", message: "Failed to update role." });
      }
    },

    // ── Moderation ─────────────────────────────────────────────────

    'server:kick': async (payload: { accessToken: string; targetServerUserId: string }) => {
      try {
        const rl = rlCheck("server:kick", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (targetId === auth.tokenPayload.serverUserId) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot kick yourself." });
          return;
        }

        const targetRole = await getServerRole(targetId);
        const actorRole = await getServerRole(auth.tokenPayload.serverUserId);
        if (targetRole === "owner" || (targetRole === "admin" && actorRole !== "owner")) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot kick a user with equal or higher role." });
          return;
        }

        for (const [sid, s] of io.sockets.sockets) {
          const ci = clientsInfo[sid];
          if (ci?.serverUserId === targetId) {
            s.emit("server:kicked", { reason: "You were kicked from the server by an admin." });
            s.disconnect(true);
          }
        }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "kick", target: targetId }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:kick:success", { targetServerUserId: targetId });
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (e) {
        consola.error("server:kick failed", e);
        socket.emit("server:error", { error: "kick_failed", message: "Failed to kick user." });
      }
    },

    'server:ban': async (payload: { accessToken: string; targetServerUserId: string; reason?: string }) => {
      try {
        const rl = rlCheck("server:ban", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (targetId === auth.tokenPayload.serverUserId) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot ban yourself." });
          return;
        }

        const targetRole = await getServerRole(targetId);
        const actorRole = await getServerRole(auth.tokenPayload.serverUserId);
        if (targetRole === "owner" || (targetRole === "admin" && actorRole !== "owner")) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot ban a user with equal or higher role." });
          return;
        }

        // Resolve the grytUserId for the target so we can store the ban
        let targetGrytUserId: string | undefined;
        for (const ci of Object.values(clientsInfo)) {
          if (ci.serverUserId === targetId && ci.grytUserId) {
            targetGrytUserId = ci.grytUserId;
            break;
          }
        }
        if (!targetGrytUserId) {
          // Fallback: look up from DB
          const { getUserByServerId } = await import("../../db/users");
          const user = await getUserByServerId(targetId);
          targetGrytUserId = user?.gryt_user_id;
        }
        if (!targetGrytUserId) {
          socket.emit("server:error", { error: "not_found", message: "Could not resolve user for ban." });
          return;
        }

        await banUser(targetGrytUserId, auth.tokenPayload.serverUserId, payload.reason);

        for (const [sid, s] of io.sockets.sockets) {
          const ci = clientsInfo[sid];
          if (ci?.serverUserId === targetId) {
            s.emit("server:kicked", { reason: "You were banned from the server." });
            s.disconnect(true);
          }
        }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "ban", target: targetId, meta: { reason: payload.reason ?? null } }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:ban:success", { targetServerUserId: targetId });
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (e) {
        consola.error("server:ban failed", e);
        socket.emit("server:error", { error: "ban_failed", message: "Failed to ban user." });
      }
    },

    'server:unban': async (payload: { accessToken: string; grytUserId: string }) => {
      try {
        const rl = rlCheck("server:unban", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.grytUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "grytUserId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        await unbanUser(payload.grytUserId.trim());
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "unban", target: payload.grytUserId.trim() }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:unban:success", { grytUserId: payload.grytUserId.trim() });
      } catch (e) {
        consola.error("server:unban failed", e);
        socket.emit("server:error", { error: "unban_failed", message: "Failed to unban user." });
      }
    },

    'server:bans:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;
        const bans = await listBans();
        socket.emit("server:bans", { serverId, bans });
      } catch (e) {
        consola.error("server:bans:list failed", e);
        socket.emit("server:error", { error: "bans_failed", message: "Failed to list bans." });
      }
    },

    'server:mute': async (payload: { accessToken: string; targetServerUserId: string; muted: boolean }) => {
      try {
        const rl = rlCheck("server:mute", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string" || typeof payload.muted !== "boolean") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId and muted required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (targetId === auth.tokenPayload.serverUserId) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot server-mute yourself." });
          return;
        }

        const targetRole = await getServerRole(targetId);
        const actorRole = await getServerRole(auth.tokenPayload.serverUserId);
        if (targetRole === "owner" || (targetRole === "admin" && actorRole !== "owner")) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot server-mute a user with equal or higher role." });
          return;
        }

        for (const [sid, s] of io.sockets.sockets) {
          const ci = clientsInfo[sid];
          if (ci?.serverUserId === targetId) {
            ci.isServerMuted = payload.muted;
            s.emit("server:muted", { muted: payload.muted });

            if (sfuClient && ci.hasJoinedChannel) {
              const roomId = `${ci.serverUserId}:${ci.streamID}`;
              sfuClient.updateUserAudioState(roomId, sid, ci.isMuted || ci.isServerMuted, ci.isDeafened || ci.isServerDeafened).catch((e) => {
                consola.error("Failed to update SFU audio state after server mute:", e);
              });
            }
          }
        }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: payload.muted ? "server_mute" : "server_unmute", target: targetId }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:mute:success", { targetServerUserId: targetId, muted: payload.muted });
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (e) {
        consola.error("server:mute failed", e);
        socket.emit("server:error", { error: "mute_failed", message: "Failed to mute user." });
      }
    },

    'server:deafen': async (payload: { accessToken: string; targetServerUserId: string; deafened: boolean }) => {
      try {
        const rl = rlCheck("server:deafen", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string" || typeof payload.deafened !== "boolean") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId and deafened required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (targetId === auth.tokenPayload.serverUserId) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot server-deafen yourself." });
          return;
        }

        const targetRole = await getServerRole(targetId);
        const actorRole = await getServerRole(auth.tokenPayload.serverUserId);
        if (targetRole === "owner" || (targetRole === "admin" && actorRole !== "owner")) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot server-deafen a user with equal or higher role." });
          return;
        }

        for (const [sid, s] of io.sockets.sockets) {
          const ci = clientsInfo[sid];
          if (ci?.serverUserId === targetId) {
            ci.isServerDeafened = payload.deafened;
            s.emit("server:deafened", { deafened: payload.deafened });

            if (sfuClient && ci.hasJoinedChannel) {
              const roomId = `${ci.serverUserId}:${ci.streamID}`;
              sfuClient.updateUserAudioState(roomId, sid, ci.isMuted || ci.isServerMuted, ci.isDeafened || ci.isServerDeafened).catch((e) => {
                consola.error("Failed to update SFU audio state after server deafen:", e);
              });
            }
          }
        }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: payload.deafened ? "server_deafen" : "server_undeafen", target: targetId }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:deafen:success", { targetServerUserId: targetId, deafened: payload.deafened });
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (e) {
        consola.error("server:deafen failed", e);
        socket.emit("server:error", { error: "deafen_failed", message: "Failed to deafen user." });
      }
    },

    // ── Audit ────────────────────────────────────────────────────

    'server:audit:list': async (payload: { accessToken: string; limit?: number; before?: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;
        const limit = typeof payload.limit === "number" ? payload.limit : 50;
        const before = typeof payload.before === "string" ? new Date(payload.before) : undefined;
        const items = await listServerAudit(limit, before && Number.isFinite(before.getTime()) ? before : undefined);
        socket.emit("server:audit", {
          serverId,
          items: items.map((it) => ({
            createdAt: it.created_at, eventId: it.event_id, actorServerUserId: it.actor_server_user_id,
            action: it.action, target: it.target,
            meta: it.meta_json ? (() => { try { return JSON.parse(it.meta_json); } catch { return it.meta_json; } })() : null,
          })),
        });
      } catch (e) {
        consola.error("server:audit:list failed", e);
        socket.emit("server:error", { error: "audit_failed", message: "Failed to load audit log." });
      }
    },

    // ── Channels & Sidebar (from adminChannels.ts) ──────────────
    ...registerAdminChannelHandlers(ctx),
  };
}
