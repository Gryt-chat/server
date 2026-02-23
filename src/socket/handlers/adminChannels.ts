import consola from "consola";
import { randomUUID } from "crypto";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import { sendServerDetails, broadcastServerUiUpdate } from "../utils/server";
import {
  listServerChannels,
  upsertServerChannel,
  deleteServerChannel,
  ensureDefaultSidebarItems,
  listServerSidebarItems,
  upsertServerSidebarItem,
  deleteServerSidebarItem,
  insertServerAudit,
} from "../../db/scylla";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";

const RL_SETTINGS: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 20, scoreDecayMs: 3_000 };

function rlCheck(event: string, ctx: HandlerContext, rule: RateLimitRule) {
  const ip = ctx.getClientIp();
  const userId = ctx.clientsInfo[ctx.clientId]?.serverUserId;
  return checkRateLimit(event, userId, ip, rule);
}

function emitRateLimited(ctx: HandlerContext, rl: any) {
  ctx.socket.emit("server:error", {
    error: "rate_limited",
    retryAfterMs: rl.retryAfterMs,
    message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
  });
}

function broadcastDetails(ctx: HandlerContext) {
  const { io, clientsInfo, serverId } = ctx;
  for (const [sid, s] of io.sockets.sockets) {
    if (clientsInfo[sid]?.grytUserId) {
      sendServerDetails(s as any, clientsInfo, serverId).catch(() => undefined);
    }
  }
}

export function registerAdminChannelHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo } = ctx;

  return {
    // ── Channels ─────────────────────────────────────────────────

    'server:channels:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload);
        if (!auth) return;
        const chans = await listServerChannels();
        socket.emit("server:channels", {
          serverId,
          channels: chans.map((c) => ({
            id: c.channel_id, name: c.name, type: c.type, description: c.description, position: c.position,
            requirePushToTalk: c.require_push_to_talk || false,
            disableRnnoise: c.disable_rnnoise || false,
            maxBitrate: c.max_bitrate ?? null,
            eSportsMode: c.esports_mode || false,
            textInVoice: c.text_in_voice || false,
          })),
        });
      } catch (e) {
        consola.error("server:channels:list failed", e);
        socket.emit("server:error", { error: "channels_failed", message: "Failed to list channels." });
      }
    },

    'server:channels:upsert': async (payload: {
      accessToken: string; channelId?: string; name: string; type: "text" | "voice";
      description?: string | null; position?: number;
      requirePushToTalk?: boolean; disableRnnoise?: boolean; maxBitrate?: number | null;
      eSportsMode?: boolean; textInVoice?: boolean;
    }) => {
      try {
        const rl = rlCheck("server:channels:upsert", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.name !== "string" || typeof payload.type !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "name and type required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const channelId = (payload.channelId?.trim() || `chan_${randomUUID().slice(0, 10)}`);
        await upsertServerChannel({
          channelId, name: payload.name, type: payload.type,
          position: payload.position, description: payload.description ?? null,
          requirePushToTalk: payload.requirePushToTalk,
          disableRnnoise: payload.disableRnnoise,
          maxBitrate: payload.maxBitrate,
          eSportsMode: payload.eSportsMode,
          textInVoice: payload.textInVoice,
        });
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channel_upsert", target: channelId, meta: { name: payload.name, type: payload.type } }).catch(() => undefined);
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:channels:upsert failed", e);
        socket.emit("server:error", { error: "channels_update_failed", message: "Failed to update channel." });
      }
    },

    'server:channels:delete': async (payload: { accessToken: string; channelId: string }) => {
      try {
        const rl = rlCheck("server:channels:delete", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.channelId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "channelId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const channelId = payload.channelId.trim();

        let channelType: "text" | "voice" = "text";
        try {
          const chans = await listServerChannels();
          const ch = chans.find((c) => c.channel_id === channelId);
          channelType = ch?.type === "voice" ? "voice" : "text";
        } catch { /* ignore */ }

        if (channelType === "voice") {
          for (const [sid, s] of io.sockets.sockets) {
            const ci = clientsInfo[sid];
            if (!ci?.grytUserId || !ci.hasJoinedChannel) continue;
            if (ci.voiceChannelId !== channelId) continue;
            try {
              (s as any).emit("voice:channel:joined", false);
              (s as any).emit("voice:stream:set", "");
              (s as any).emit("voice:room:leave");
            } catch { /* ignore */ }
            ci.hasJoinedChannel = false;
            ci.voiceChannelId = "";
            ci.streamID = "";
            ci.isConnectedToVoice = false;
            if (ctx.sfuClient && ci.serverUserId) {
              try { ctx.sfuClient.untrackUserConnection(ci.serverUserId); } catch { /* ignore */ }
            }
          }
          syncAllClients(io, clientsInfo);
          broadcastMemberList(io, clientsInfo, serverId).catch(() => undefined);
        }

        await deleteServerChannel(channelId);

        try {
          const items = await listServerSidebarItems();
          for (const it of items.filter((i) => i.kind === "channel" && i.channel_id === channelId)) {
            await deleteServerSidebarItem(it.item_id);
          }
        } catch { /* ignore */ }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channel_delete", target: channelId }).catch(() => undefined);
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:channels:delete failed", e);
        socket.emit("server:error", { error: "channels_delete_failed", message: "Failed to delete channel." });
      }
    },

    'server:channels:reorder': async (payload: { accessToken: string; order: string[] }) => {
      try {
        const rl = rlCheck("server:channels:reorder", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || !Array.isArray(payload.order)) {
          socket.emit("server:error", { error: "invalid_payload", message: "order required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const chans = await listServerChannels();
        const byId = new Map(chans.map((c) => [c.channel_id, c]));
        let pos = 10;
        for (const id of payload.order) {
          const ch = byId.get(id);
          if (!ch) continue;
          await upsertServerChannel({ channelId: ch.channel_id, name: ch.name, type: ch.type, description: ch.description, position: pos });
          pos += 10;
        }
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channels_reorder", meta: { order: payload.order } }).catch(() => undefined);
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:channels:reorder failed", e);
        socket.emit("server:error", { error: "channels_reorder_failed", message: "Failed to reorder." });
      }
    },

    // ── Sidebar ──────────────────────────────────────────────────

    'server:sidebar:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload);
        if (!auth) return;
        await ensureDefaultSidebarItems();
        const items = await listServerSidebarItems();
        socket.emit("server:sidebar", {
          serverId,
          items: items.map((it) => ({ id: it.item_id, kind: it.kind, position: it.position, channelId: it.channel_id ?? null, spacerHeight: it.spacer_height ?? null, label: it.label ?? null })),
        });
      } catch (e) {
        consola.error("server:sidebar:list failed", e);
        socket.emit("server:error", { error: "sidebar_failed", message: "Failed to list sidebar." });
      }
    },

    'server:sidebar:item:upsert': async (payload: {
      accessToken: string; itemId: string; kind: "channel" | "separator" | "spacer";
      position?: number; channelId?: string | null; spacerHeight?: number | null; label?: string | null;
    }) => {
      try {
        const rl = rlCheck("server:sidebar:item:upsert", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.itemId !== "string" || typeof payload.kind !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "itemId and kind required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        await upsertServerSidebarItem({ itemId: payload.itemId, kind: payload.kind, position: payload.position, channelId: payload.channelId ?? null, spacerHeight: payload.spacerHeight ?? null, label: payload.label ?? null });
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_item_upsert", target: payload.itemId, meta: { kind: payload.kind } }).catch(() => undefined);
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:sidebar:item:upsert failed", e);
        socket.emit("server:error", { error: "sidebar_update_failed", message: "Failed to update sidebar." });
      }
    },

    'server:sidebar:item:delete': async (payload: { accessToken: string; itemId: string }) => {
      try {
        const rl = rlCheck("server:sidebar:item:delete", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.itemId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "itemId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        await deleteServerSidebarItem(payload.itemId);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_item_delete", target: payload.itemId }).catch(() => undefined);
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:sidebar:item:delete failed", e);
        socket.emit("server:error", { error: "sidebar_delete_failed", message: "Failed to delete sidebar item." });
      }
    },

    'server:sidebar:reorder': async (payload: { accessToken: string; order: string[] }) => {
      try {
        const rl = rlCheck("server:sidebar:reorder", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || !Array.isArray(payload.order)) {
          socket.emit("server:error", { error: "invalid_payload", message: "order required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { requiredRole: "admin" });
        if (!auth) return;

        const items = await listServerSidebarItems();
        const byId = new Map(items.map((it) => [it.item_id, it]));
        let pos = 10;
        for (const id of payload.order) {
          const it = byId.get(String(id || "").trim());
          if (!it) continue;
          await upsertServerSidebarItem({ itemId: it.item_id, kind: it.kind, position: pos, channelId: it.channel_id, spacerHeight: it.spacer_height, label: it.label });
          pos += 10;
        }
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_reorder", meta: { order: payload.order } }).catch(() => undefined);
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:sidebar:reorder failed", e);
        socket.emit("server:error", { error: "sidebar_reorder_failed", message: "Failed to reorder sidebar." });
      }
    },
  };
}
