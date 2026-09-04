import { sfuRoomId, voiceRoomName } from "../utils/voiceRooms";
import { forgetStashedVoiceState } from "../utils/voiceStash";
import consola from "consola";
import { randomUUID } from "crypto";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import { syncAllClients, broadcastMemberList, invalidateBroadcastDedupe } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import {
  listServerChannels,
  upsertServerChannel,
  deleteServerChannel,
  ensureDefaultSidebarItems,
  listServerSidebarItems,
  upsertServerSidebarItem,
  deleteServerSidebarItem,
  insertServerAudit,
  listPermissionTemplates,
  listPermissionRules,
  listAllPermissionRules,
  getPermissionScope,
  createPermissionScope,
  replacePermissionRules,
  setChannelPermissionScope,
  deletePermissionTemplate,
} from "../../db";
import { CHANNEL_PERMISSIONS } from "../../constants/permissions";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { mayViewChannel, resetChannelPermissionCache } from "../../services/channelPermissions";
import { resetChannelIdCache } from "../utils/conversationAccess";

const RL_SETTINGS: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 20, scoreDecayMs: 3_000 };

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

/**
 * Turn out anybody sitting in a voice channel they can no longer see, or the
 * gate only decides who may *arrive* — they keep hearing the room and the SFU
 * keeps routing their audio.
 *
 * Deliberately not shared with the delete path: that one forgets the stashed
 * voice state, and this one must not, because a lowered gate can put them back.
 */
async function evictNewlyHidden(ctx: HandlerContext, channelId: string): Promise<void> {
  const { io, clientsInfo, serverId } = ctx;
  const roomName = voiceRoomName(serverId, channelId);
  let evicted = false;

  for (const [sid, s] of io.sockets.sockets) {
    const ci = clientsInfo[sid];
    if (!ci?.grytUserId || ci.voiceChannelId !== channelId) continue;
    if (await mayViewChannel(channelId, ci.serverUserId, ci.grytUserId)) continue;

    try {
      s.leave(roomName);
      s.emit("voice:channel:joined", false);
      s.emit("voice:stream:set", "");
      s.emit("voice:room:leave");
    } catch { /* the socket went away */ }
    ci.hasJoinedChannel = false;
    ci.voiceChannelId = "";
    ci.streamID = "";
    ci.isConnectedToVoice = false;
    if (ctx.sfuClient && ci.serverUserId) {
      try { ctx.sfuClient.untrackUserConnection(ci.serverUserId); } catch { /* ignore */ }
    }
    evicted = true;
  }

  if (evicted) {
    syncAllClients(io, clientsInfo);
    broadcastMemberList(io, clientsInfo, serverId);
  }
}

/**
 * The same eviction, across every channel — editing a template can hide four
 * channels from three roles in one save.
 */
async function evictNewlyHiddenEverywhere(ctx: HandlerContext): Promise<void> {
  const channels = await listServerChannels().catch(() => []);
  for (const channel of channels) {
    if (channel.type !== "voice") continue;
    await evictNewlyHidden(ctx, channel.channel_id);
  }
}

function broadcastDetails(ctx: HandlerContext) {
  const { io, clientsInfo, serverId } = ctx;
  for (const [sid, s] of io.sockets.sockets) {
    if (clientsInfo[sid]?.grytUserId) {
      sendServerDetails(s, clientsInfo, serverId).catch((e) => consola.warn("sendServerDetails failed", e));
    }
  }
}

export function registerAdminChannelHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, serverId, clientsInfo } = ctx;

  return {
    // ── Channels ─────────────────────────────────────────────────

    /**
     * Every channel, gates included, for the channel editor. Needs
     * `manage_channels` — signed-in alone would hand any member the name,
     * description and gate of every channel hidden from them.
     *
     * Deliberately unfiltered for whoever holds the permission: an editor that
     * hid rows would produce an admin setting a gate twice.
     */
    'server:channels:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
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
            permissionScopeId: c.permission_scope_id ?? null,
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
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;

        const channelId = (payload.channelId?.trim() || `chan_${randomUUID().slice(0, 10)}`);

        /*
         * Create or edit, decided before the write. A new channel needs a
         * sidebar row or nobody sees it — `server:details` builds its list from
         * the sidebar, and nothing else was going to add one. The desktop sent
         * its own upsert, so any other client created a channel that answers
         * `chat:fetch`, accepts `chat:send`, and appears to nobody (GRYT-839).
         *
         * On an edit nothing is added: taking a channel out of the sidebar is
         * deliberate, and a rename must not undo it.
         */
        let isNewChannel = false;
        try {
          const existing = await listServerChannels();
          isNewChannel = !existing.some((c) => c.channel_id === channelId);
        } catch (e) {
          // Treated as an edit. A channel that needs its row added by hand is a
          // smaller problem than a duplicate row, which draws it twice.
          consola.warn("could not tell whether the channel is new", e);
        }

        await upsertServerChannel({
          channelId, name: payload.name, type: payload.type,
          position: payload.position, description: payload.description ?? null,
          requirePushToTalk: payload.requirePushToTalk,
          disableRnnoise: payload.disableRnnoise,
          maxBitrate: payload.maxBitrate,
          eSportsMode: payload.eSportsMode,
          textInVoice: payload.textInVoice,
        });
        if (isNewChannel) {
          try {
            const items = await listServerSidebarItems();
            const already = items.some((i) => i.kind === "channel" && i.channel_id === channelId);
            if (!already) {
              const end = items.reduce((max, i) => Math.max(max, i.position ?? 0), 0) + 10;
              await upsertServerSidebarItem({
                itemId: `sb_ch_${channelId.slice(0, 54)}`,
                kind: "channel",
                channelId,
                position: end,
              });
            }
          } catch (e) {
            consola.warn("could not add a sidebar row for the new channel", e);
          }
        }

        // The scope is not touched here — server:channels:scope owns it. A
        // rename must not be able to change who can see the channel.
        resetChannelPermissionCache();
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channel_upsert", target: channelId, meta: { name: payload.name, type: payload.type } }).catch((e) => consola.warn("audit log write failed", e));
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
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;

        const channelId = payload.channelId.trim();

        let channelType: "text" | "voice" = "text";
        try {
          const chans = await listServerChannels();
          const ch = chans.find((c) => c.channel_id === channelId);
          channelType = ch?.type === "voice" ? "voice" : "text";
        } catch { /* ignore */ }

        if (channelType === "voice") {
          const roomName = voiceRoomName(serverId, channelId);
          for (const [sid, s] of io.sockets.sockets) {
            const ci = clientsInfo[sid];
            if (!ci?.grytUserId || !ci.hasJoinedChannel) continue;
            if (ci.voiceChannelId !== channelId) continue;
            try {
              s.leave(roomName);
              s.emit("voice:channel:joined", false);
              s.emit("voice:stream:set", "");
              s.emit("voice:room:leave");
            } catch { /* ignore */ }
            ci.hasJoinedChannel = false;
            ci.voiceChannelId = "";
            ci.streamID = "";
            ci.isConnectedToVoice = false;
            if (ctx.sfuClient && ci.serverUserId) {
              try { ctx.sfuClient.untrackUserConnection(ci.serverUserId); } catch { /* ignore */ }
            }
            // The channel is being deleted, so there is nothing to restore them
            // into if their socket drops before the SFU catches up.
            if (ci.serverUserId) forgetStashedVoiceState(ci.serverUserId);
          }
          syncAllClients(io, clientsInfo);
          broadcastMemberList(io, clientsInfo, serverId);
        }

        await deleteServerChannel(channelId);
        // Both caches hold this id. Leaving the visibility one would let a
        // recreated channel inherit the deleted one's gate for fifteen seconds;
        // leaving the existence one would refuse history in a channel that is
        // gone anyway, which is harmless, but they are dropped together so
        // nobody has to work out which is which later.
        resetChannelPermissionCache();
        resetChannelIdCache();
        invalidateBroadcastDedupe(io);

        try {
          const items = await listServerSidebarItems();
          for (const it of items.filter((i) => i.kind === "channel" && i.channel_id === channelId)) {
            await deleteServerSidebarItem(it.item_id);
          }
        } catch { /* ignore */ }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channel_delete", target: channelId }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:channels:delete failed", e);
        socket.emit("server:error", { error: "channels_delete_failed", message: "Failed to delete channel." });
      }
    },

    // ── Permission scopes and templates ──────────────────────────

    /**
     * Every template and its rules. Templates only — a channel's private
     * "Custom" scope comes down with the channel in `…:scope:get`.
     */
    'server:permissions:templates:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;

        const [templates, rulesByScope, channels] = await Promise.all([
          listPermissionTemplates(),
          listAllPermissionRules(),
          listServerChannels(),
        ]);

        // How many channels each template decides. Editing a template changes
        // every one of them at once, so this is the number somebody wants
        // before they touch a row — and the one that makes the difference
        // between a safe edit and a frightening one.
        const usedBy = new Map<string, number>();
        for (const channel of channels) {
          if (!channel.permission_scope_id) continue;
          usedBy.set(channel.permission_scope_id, (usedBy.get(channel.permission_scope_id) ?? 0) + 1);
        }

        socket.emit("server:permissions:templates", {
          serverId,
          permissions: CHANNEL_PERMISSIONS,
          templates: templates.map((t) => ({
            id: t.scope_id,
            name: t.name,
            isSystem: t.is_system,
            channelCount: usedBy.get(t.scope_id) ?? 0,
            rules: (rulesByScope.get(t.scope_id) ?? []).map((r) => ({
              roleId: r.role_id,
              permission: r.permission,
              effect: r.effect,
            })),
          })),
        });
      } catch (e) {
        consola.error("server:permissions:templates:list failed", e);
        socket.emit("server:error", { error: "templates_failed", message: "Failed to list permission templates." });
      }
    },

    /**
     * Create a template, or replace the rules in one. `rules` is the whole
     * matrix, not a patch: a cell set back to inherit is simply absent, and
     * patching would leave inherit unreachable once anything had been set.
     */
    'server:permissions:template:save': async (payload: {
      accessToken: string;
      templateId?: string;
      name: string;
      rules?: { roleId: string; permission: string; effect: string }[];
    }) => {
      try {
        const rl = rlCheck("server:permissions:template:save", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.name !== "string" || !payload.name.trim()) {
          socket.emit("server:error", { error: "invalid_payload", message: "name required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;

        const scopeId = await createPermissionScope({
          scopeId: payload.templateId,
          name: payload.name,
          isTemplate: true,
        });
        await replacePermissionRules(scopeId, payload.rules ?? []);

        // Every channel pointing at this template just changed, so this is the
        // one edit that can hide several channels at once. Cache first, then
        // evict, then tell everybody.
        resetChannelPermissionCache();
        invalidateBroadcastDedupe(io);
        await evictNewlyHiddenEverywhere(ctx);
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "permission_template_save", target: scopeId, meta: { name: payload.name, rules: (payload.rules ?? []).length } }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:permissions:template:save failed", e);
        socket.emit("server:error", { error: "template_save_failed", message: "Failed to save the template." });
      }
    },

    'server:permissions:template:delete': async (payload: { accessToken: string; templateId: string }) => {
      try {
        const rl = rlCheck("server:permissions:template:delete", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.templateId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "templateId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;

        // Channels using it go back to inheriting, which can only widen access.
        // No eviction needed: nobody loses a channel by this.
        await deletePermissionTemplate(payload.templateId);
        resetChannelPermissionCache();
        invalidateBroadcastDedupe(io);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "permission_template_delete", target: payload.templateId }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:permissions:template:delete failed", e);
        socket.emit("server:error", { error: "template_delete_failed", message: "Failed to delete the template." });
      }
    },

    /**
     * One channel's scope and rules, plus the names and ids of templates it
     * could point at. Choosing a scope is `manage_channels`; what a template
     * *says* is policy and stays behind `manage_roles`.
     *
     * Without the names, somebody holding only `manage_channels` was offered
     * Everyone and Custom — allowed to pick a template, unable to discover one
     * existed. Invisible while the owner holds everything.
     */
    'server:channels:scope:get': async (payload: { accessToken: string; channelId: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;
        if (!payload || typeof payload.channelId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "channelId required." });
          return;
        }

        const [channels, templates] = await Promise.all([
          listServerChannels(),
          listPermissionTemplates(),
        ]);
        const channel = channels.find((c) => c.channel_id === payload.channelId);
        const scopeId = channel?.permission_scope_id ?? null;
        const scope = scopeId ? await getPermissionScope(scopeId) : null;

        socket.emit("server:channels:scope", {
          serverId,
          channelId: payload.channelId,
          permissions: CHANNEL_PERMISSIONS,
          scopeId,
          // Names to choose from, without what they decide. Somebody who may
          // point a channel at "Staff only" can already watch what that does;
          // the rules behind it are the part they may not read.
          templates: templates.map((t) => ({
            id: t.scope_id,
            name: t.name,
            isSystem: t.is_system,
          })),
          // The client draws a dropdown from this: null is "Everyone",
          // is_template is the template's name, and neither is "Custom".
          isTemplate: scope?.is_template ?? false,
          name: scope?.name ?? null,
          rules: scopeId
            ? (await listPermissionRules(scopeId)).map((r) => ({
                roleId: r.role_id,
                permission: r.permission,
                effect: r.effect,
              }))
            : [],
        });
      } catch (e) {
        consola.error("server:channels:scope:get failed", e);
        socket.emit("server:error", { error: "scope_failed", message: "Failed to read channel permissions." });
      }
    },

    /**
     * Point a channel at a template, at nothing, or at its own custom rules.
     * `templateId` picks one, `custom: true` writes `rules` into the channel's
     * private scope, neither goes back to inheriting.
     */
    'server:channels:scope:set': async (payload: {
      accessToken: string;
      channelId: string;
      templateId?: string | null;
      custom?: boolean;
      rules?: { roleId: string; permission: string; effect: string }[];
    }) => {
      try {
        const rl = rlCheck("server:channels:scope:set", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.channelId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "channelId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;

        const channelId = payload.channelId.trim();
        const channels = await listServerChannels();
        const channel = channels.find((c) => c.channel_id === channelId);
        if (!channel) {
          socket.emit("server:error", { error: "not_found", message: "No such channel." });
          return;
        }

        if (payload.custom) {
          // Reuse the channel's own scope if it already has one, so switching
          // Custom -> template -> Custom does not leave scopes behind. A
          // template id is never reused: writing this channel's rules into a
          // shared template would change every other channel using it.
          const existing = channel.permission_scope_id
            ? await getPermissionScope(channel.permission_scope_id)
            : null;
          const scopeId = existing && !existing.is_template
            ? existing.scope_id
            : await createPermissionScope({ isTemplate: false });
          await replacePermissionRules(scopeId, payload.rules ?? []);
          await setChannelPermissionScope(channelId, scopeId);
        } else if (payload.templateId) {
          const template = await getPermissionScope(payload.templateId);
          if (!template?.is_template) {
            socket.emit("server:error", { error: "not_found", message: "No such template." });
            return;
          }
          await setChannelPermissionScope(channelId, payload.templateId);
        } else {
          await setChannelPermissionScope(channelId, null);
        }

        // Cache before eviction before broadcast. broadcastDetails calls
        // sendServerDetails for every socket and each reads the rules; off a
        // stale cache it would tell everybody about a channel that was just
        // hidden, which is the one ordering that leaks.
        resetChannelPermissionCache();
        invalidateBroadcastDedupe(io);
        await evictNewlyHidden(ctx, channelId);
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channel_scope_set", target: channelId, meta: { templateId: payload.templateId ?? null, custom: Boolean(payload.custom) } }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:channels:scope:set failed", e);
        socket.emit("server:error", { error: "scope_set_failed", message: "Failed to set channel permissions." });
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
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
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
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channels_reorder", meta: { order: payload.order } }).catch((e) => consola.warn("audit log write failed", e));
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
        const auth = await requireAuth(socket, payload, { permission: "manage_sidebar" });
        if (!auth) return;

        await upsertServerSidebarItem({ itemId: payload.itemId, kind: payload.kind, position: payload.position, channelId: payload.channelId ?? null, spacerHeight: payload.spacerHeight ?? null, label: payload.label ?? null });

        /*
         * One row per channel, or the sidebar draws it twice — which the fix
         * above would otherwise cause, since the desktop sends this right after
         * `server:channels:upsert` with an item id of its own. The row named in
         * this payload wins, being the explicit instruction.
         */
        if (payload.kind === "channel" && payload.channelId) {
          try {
            const items = await listServerSidebarItems();
            for (const other of items) {
              if (other.item_id === payload.itemId) continue;
              if (other.kind !== "channel" || other.channel_id !== payload.channelId) continue;
              await deleteServerSidebarItem(other.item_id);
            }
          } catch (e) {
            consola.warn("could not clear duplicate sidebar rows", e);
          }
        }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_item_upsert", target: payload.itemId, meta: { kind: payload.kind } }).catch((e) => consola.warn("audit log write failed", e));
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
        const auth = await requireAuth(socket, payload, { permission: "manage_sidebar" });
        if (!auth) return;

        await deleteServerSidebarItem(payload.itemId);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_item_delete", target: payload.itemId }).catch((e) => consola.warn("audit log write failed", e));
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
        const auth = await requireAuth(socket, payload, { permission: "manage_sidebar" });
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
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_reorder", meta: { order: payload.order } }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:sidebar:reorder failed", e);
        socket.emit("server:error", { error: "sidebar_reorder_failed", message: "Failed to reorder sidebar." });
      }
    },
  };
}
