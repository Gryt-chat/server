import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth, requireOutranks } from "../middleware/auth";
import { broadcastServerUiUpdate, sendEmojiQueueStateToSocket } from "../utils/server";
import { invalidateSystemChannelCache } from "../utils/systemMessages";
import { VALID_CENSOR_STYLES, type CensorStyle } from "../../utils/profanityFilter";
import { syncMdnsAdvertising } from "../../mdns";
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
  setServerRole,
  listServerRoles,
  insertServerAudit,
  listServerAudit,
  banUser,
  unbanUser,
  listBans,
  getUserByServerId,
} from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { evictUser, resolveGrytUserId } from "../../moderation/evict";
import { getVersionStatus } from "../../versionCheck";
import { registerAdminChannelHandlers } from "./adminChannels";

const RL_SETTINGS: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 20, scoreDecayMs: 3_000 };
const RL_INVITE: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 5_000 };
const RL_MODERATION: RateLimitRule = { limit: 15, windowMs: 60_000, scorePerAction: 2, maxScore: 10, scoreDecayMs: 5_000 };

function rlCheck(event: string, ctx: HandlerContext, rule: RateLimitRule) {
  const ip = ctx.getClientIp();
  const userId = ctx.clientsInfo[ctx.clientId]?.serverUserId;
  return checkRateLimit(event, userId, ip, rule);
}

/** A year, in minutes. Longer than this is what a permanent ban is for. */
const MAX_BAN_MINUTES = 525_600;

/**
 * When a ban should lift, from a duration in minutes.
 *
 * Absent, null, or anything that is not a usable number means permanent, which
 * keeps every existing caller — none of which send this field — behaving as it
 * did. A garbled number is treated as permanent rather than rejected: refusing
 * the whole ban because the duration was malformed would be the wrong way to
 * fail for a moderation action someone is taking right now.
 */
function resolveBanExpiry(expiresInMinutes?: number | null): Date | null {
  if (expiresInMinutes === undefined || expiresInMinutes === null) return null;
  const minutes = Math.floor(Number(expiresInMinutes));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(Date.now() + Math.min(minutes, MAX_BAN_MINUTES) * 60_000);
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
          systemChannelId: cfg.system_channel_id ?? null,
          lanOpen: !!cfg.lan_open,
          discoverable: cfg.discoverable !== false,
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
      systemChannelId?: string | null;
      lanOpen?: boolean;
      discoverable?: boolean;
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

        /**
         * Same as clampBytes, except zero survives.
         *
         * The enforcement code has always treated `maxBytes > 0` as "there is a
         * limit", so zero has always meant unlimited — but the clamp's 256 KB
         * floor meant zero could never be stored, and that branch was dead from
         * the day it was written. Uploads stream to storage now, so unlimited
         * costs bounded memory rather than the file's size, and the branch can
         * finally be reached.
         *
         * Only uploads. Avatars and emoji are still held in memory to be
         * re-encoded, so unlimited would mean unlimited RAM there.
         */
        const clampBytesAllowingZero = (v: number | null | undefined, min: number, max: number): number | null | undefined => {
          const n = typeof v === "number" ? v : Number(v);
          if (v !== undefined && v !== null && Number.isFinite(n) && Math.floor(n) === 0) return 0;
          return clampBytes(v, min, max);
        };

        // 200 MB on both, matching uploads' old backstop. Generous on purpose:
        // an avatar or emoji is re-encoded on the way in, so what an operator is
        // really choosing is how large a source file they will accept, not how
        // much they will store. What bounds the memory is MAX_INPUT_PIXELS in
        // imageValidation, not this number — see the limitInputPixels on every
        // sharp call in routes/uploads.ts.
        const avatarMaxBytes = clampBytes(payload.avatarMaxBytes, 256 * 1024, 200 * 1024 * 1024);
        // No upper clamp: the operator's number is the operator's number, and
        // the ceiling that used to sit above it here and in multer is gone.
        const uploadMaxBytes = clampBytesAllowingZero(payload.uploadMaxBytes, 256 * 1024, Number.MAX_SAFE_INTEGER);
        const emojiMaxBytes = clampBytes(payload.emojiMaxBytes, 64 * 1024, 200 * 1024 * 1024);

        const validProfanityModes = ["off", "flag", "censor", "block"] as const;
        const profanityMode = typeof payload.profanityMode === "string" && validProfanityModes.includes(payload.profanityMode as typeof validProfanityModes[number])
          ? payload.profanityMode as typeof validProfanityModes[number]
          : undefined;

        const profanityCensorStyle: CensorStyle | undefined =
          typeof payload.profanityCensorStyle === "string" && VALID_CENSOR_STYLES.includes(payload.profanityCensorStyle as CensorStyle)
            ? payload.profanityCensorStyle as CensorStyle
            : undefined;

        const systemChannelId: string | null | undefined =
          payload.systemChannelId === null ? null
            : typeof payload.systemChannelId === "string" ? payload.systemChannelId.trim().slice(0, 64) || null
              : undefined;

        const lanOpen: boolean | undefined =
          typeof payload.lanOpen === "boolean" ? payload.lanOpen : undefined;

        const discoverable: boolean | undefined =
          typeof payload.discoverable === "boolean" ? payload.discoverable : undefined;

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
          systemChannelId,
          lanOpen,
          discoverable,
        });

        if (systemChannelId !== undefined) invalidateSystemChannelCache();

        // Take effect immediately rather than at the next restart: turning
        // discoverability off should withdraw the LAN advertisement there and
        // then, and turning it back on should re-publish it.
        if (discoverable !== undefined) {
          void syncMdnsAdvertising().catch((e) =>
            consola.warn("mDNS: re-sync after a settings change failed", e)
          );
        }

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
          systemChannelId: updated.system_channel_id ?? null,
          lanOpen: !!updated.lan_open,
          discoverable: updated.discoverable !== false,
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

    'server:invites:create': async (payload: { accessToken: string; infinite?: boolean; maxUses?: number; expiresInHours?: number; note?: string | null; customCode?: string | null }) => {
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
        const customCode = typeof payload.customCode === "string" ? payload.customCode.trim() : null;

        const created = await createServerInvite(auth.tokenPayload.serverUserId, { infinite, maxUses, expiresAt, note: payload.note ?? null, customCode: customCode || null });
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

    'server:kick': async (payload: { accessToken: string; targetServerUserId: string; reason?: string }) => {
      try {
        const rl = rlCheck("server:kick", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "mod" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (!(await requireOutranks(socket, auth, targetId, "kick"))) return;

        const targetGrytUserId = await resolveGrytUserId(clientsInfo, targetId);
        if (!targetGrytUserId) {
          socket.emit("server:error", { error: "not_found", message: "Could not resolve user to kick." });
          return;
        }

        await evictUser({
          io,
          clientsInfo,
          targetServerUserId: targetId,
          targetGrytUserId,
          action: "kick",
          reason: payload.reason,
        });

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "kick", target: targetId, meta: { reason: payload.reason ?? null } }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:kick:success", { targetServerUserId: targetId });
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (e) {
        consola.error("server:kick failed", e);
        socket.emit("server:error", { error: "kick_failed", message: "Failed to kick user." });
      }
    },

    'server:ban': async (payload: { accessToken: string; targetServerUserId: string; reason?: string; expiresInMinutes?: number | null }) => {
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
        if (!(await requireOutranks(socket, auth, targetId, "ban"))) return;

        const targetGrytUserId = await resolveGrytUserId(clientsInfo, targetId);
        if (!targetGrytUserId) {
          socket.emit("server:error", { error: "not_found", message: "Could not resolve user for ban." });
          return;
        }

        // The ban row goes in first, so that the eviction below cannot race a
        // reconnect into the window before the gate would refuse it.
        const expiresAt = resolveBanExpiry(payload.expiresInMinutes);
        await banUser(targetGrytUserId, auth.tokenPayload.serverUserId, payload.reason, expiresAt);

        await evictUser({
          io,
          clientsInfo,
          targetServerUserId: targetId,
          targetGrytUserId,
          action: "ban",
          reason: payload.reason,
        });

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "ban", target: targetId, meta: { reason: payload.reason ?? null } }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:ban:success", { targetServerUserId: targetId });
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (e) {
        consola.error("server:ban failed", e);
        socket.emit("server:error", { error: "ban_failed", message: "Failed to ban user." });
      }
    },

    // Accepts either identifier. Ban speaks serverUserId and unban spoke
    // grytUserId, so undoing a ban meant holding a different id from the one
    // used to make it — and the bans list is the only place the grytUserId
    // appears at all.
    'server:unban': async (payload: { accessToken: string; grytUserId?: string; targetServerUserId?: string }) => {
      try {
        const rl = rlCheck("server:unban", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const directId = typeof payload?.grytUserId === "string" ? payload.grytUserId.trim() : "";
        const viaServerUserId = typeof payload?.targetServerUserId === "string" ? payload.targetServerUserId.trim() : "";
        if (!directId && !viaServerUserId) {
          socket.emit("server:error", { error: "invalid_payload", message: "grytUserId or targetServerUserId required." });
          return;
        }

        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        let grytUserId = directId;
        if (!grytUserId) {
          const user = await getUserByServerId(viaServerUserId);
          grytUserId = user?.gryt_user_id ?? "";
        }
        if (!grytUserId) {
          socket.emit("server:error", { error: "not_found", message: "Could not resolve user to unban." });
          return;
        }

        await unbanUser(grytUserId);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "unban", target: grytUserId }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:unban:success", { grytUserId });
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
        const auth = await requireAuth(socket, payload, { requiredRole: "mod" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (!(await requireOutranks(socket, auth, targetId, "server-mute"))) return;

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
        const auth = await requireAuth(socket, payload, { requiredRole: "mod" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (!(await requireOutranks(socket, auth, targetId, "server-deafen"))) return;

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

    // ── User identity replace ─────────────────────────────────────

    'server:user:replace': async (payload: { accessToken: string; targetServerUserId: string; newGrytUserId: string }) => {
      try {
        const rl = rlCheck("server:user:replace", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string" || typeof payload.newGrytUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId and newGrytUserId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "owner" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        const newGrytId = payload.newGrytUserId.trim();
        if (!targetId || !newGrytId) {
          socket.emit("server:error", { error: "invalid_payload", message: "IDs must not be empty." });
          return;
        }

        const { replaceUserIdentity } = await import("../../db");
        const result = await replaceUserIdentity(targetId, newGrytId);

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "user_identity_replace",
          target: targetId,
          meta: { oldGrytUserId: result.oldGrytUserId, newGrytUserId: newGrytId, ownerUpdated: result.ownerUpdated },
        }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("server:user:replace:success", {
          targetServerUserId: targetId,
          oldGrytUserId: result.oldGrytUserId,
          newGrytUserId: newGrytId,
          ownerUpdated: result.ownerUpdated,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to replace user identity.";
        consola.error("server:user:replace failed", e);
        socket.emit("server:error", { error: "user_replace_failed", message: msg });
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

    // ── Version check ─────────────────────────────────────────────

    'server:version:check': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;
        const status = await getVersionStatus();
        socket.emit("server:version:status", status);
      } catch (e) {
        consola.error("server:version:check failed", e);
      }
    },

    // ── Channels & Sidebar (from adminChannels.ts) ──────────────
    ...registerAdminChannelHandlers(ctx),
  };
}
