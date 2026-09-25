import { sfuRoomId, voiceRoomName } from "../utils/voiceRooms";
import { forgetStashedVoiceState } from "../utils/voiceStash";
import consola from "consola";
import { randomUUID } from "crypto";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth, requirePermission } from "../middleware/auth";
import type { ChannelNotificationLevel, ForumTag } from "../../db/interfaces";
import { syncAllClients, broadcastMemberList, invalidateBroadcastDedupe } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import { pushVoiceCapabilities } from "../utils/voiceCapabilities";
import {
  channelNotificationLevel,
  listServerChannels,
  upsertServerChannel,
  deleteServerChannel,
  ensureDefaultSidebarItems,
  listServerSidebarItems,
  upsertServerSidebarItem,
  addChannelRowIfMissing,
  deleteServerSidebarItem,
  insertServerAudit,
  listPermissionTemplates,
  listPermissionRules,
  listAllPermissionRules,
  getPermissionScope,
  createPermissionScope,
  replacePermissionRules,
  setChannelPermissionScope,
  setFolderPermissionScope,
  deletePermissionTemplate,
  resolveChannelScopes,
} from "../../db";
import { CHANNEL_PERMISSIONS } from "../../constants/permissions";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import {
  keepsEmptyFolders,
  mayViewChannel,
  resetChannelPermissionCache,
  visibleChannelIds,
  visibleSidebarItems,
} from "../../services/channelPermissions";
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

/** Without this the gate only decides who may arrive, and they keep hearing the
    room. Not shared with the delete path, which forgets the stashed state. */
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

/** The same eviction across every channel: one template save can hide four of
    them from three roles. */
async function evictNewlyHiddenEverywhere(ctx: HandlerContext): Promise<void> {
  const channels = await listServerChannels().catch(() => []);
  for (const channel of channels) {
    if (channel.type !== "voice") continue;
    await evictNewlyHidden(ctx, channel.channel_id);
  }
}

/** After a write that can change which scope decides a channel. Cache first,
    then evict, then tell everybody, as in `server:channels:scope:set`. */
async function refreshChannelAccess(ctx: HandlerContext): Promise<void> {
  const { io, clientsInfo, serverId } = ctx;
  resetChannelPermissionCache();
  invalidateBroadcastDedupe(io);
  await evictNewlyHiddenEverywhere(ctx);
  syncAllClients(io, clientsInfo);
  broadcastMemberList(io, clientsInfo, serverId);
}

async function resolvedScopesNow() {
  const [channels, items] = await Promise.all([listServerChannels(), listServerSidebarItems()]);
  return { channels, items, scopes: resolveChannelScopes(channels, items) };
}

/** Whether a sidebar write changed the scope any channel reads. */
function scopesDiffer(
  before: Map<string, { scopeId: string | null }>,
  after: Map<string, { scopeId: string | null }>,
): boolean {
  if (before.size !== after.size) return true;
  for (const [channelId, was] of before) {
    if (after.get(channelId)?.scopeId !== was.scopeId) return true;
  }
  return false;
}

/** A channel that follows its folder takes the next one's scope when it moves,
    and choosing a scope is `manage_channels`, as in `…:scope:set`. */
function movesChangeAccess(
  { channels, items, scopes }: Awaited<ReturnType<typeof resolvedScopesNow>>,
  moves: { channelId: string; parentItemId: string | null }[],
): boolean {
  const folderScopes = new Map(
    items.filter((i) => i.kind === "folder").map((i) => [i.item_id, i.permission_scope_id]),
  );
  const channelById = new Map(channels.map((c) => [c.channel_id, c]));

  return moves.some(({ channelId, parentItemId }) => {
    if (!parentItemId || !folderScopes.has(parentItemId)) return false;
    // One not written yet follows, which is what a new channel does.
    const channel = channelById.get(channelId);
    if (channel && (channel.permission_scope_id || !channel.follows_folder)) return false;
    const now = scopes.get(channelId);
    if (now?.folderId === parentItemId) return false;
    return (folderScopes.get(parentItemId) ?? null) !== (now?.scopeId ?? null);
  });
}

/** A scope as the settings dialogs draw it: null is Everyone, a template shows
    its name, and anything else is Custom. */
async function describeScope(scopeId: string | null) {
  const scope = scopeId ? await getPermissionScope(scopeId) : null;
  return {
    scopeId,
    isTemplate: scope?.is_template ?? false,
    name: scope?.name ?? null,
    rules: scopeId
      ? (await listPermissionRules(scopeId)).map((r) => ({
          roleId: r.role_id,
          permission: r.permission,
          effect: r.effect,
        }))
      : [],
  };
}

/** Names without what they decide: pointing at "Staff only" shows you what it
    does anyway, but the rules are not readable. */
async function templateNames() {
  return (await listPermissionTemplates()).map((t) => ({ id: t.scope_id, name: t.name, isSystem: t.is_system }));
}

/** What a channel reads is its folder's while it follows one, so that is what
    the dropdown shows. `followsFolder` and `folder` are absent on older servers. */
async function channelScopeReply(channelId: string) {
  const { items, scopes } = await resolvedScopesNow();
  const resolved = scopes.get(channelId);
  const folder = resolved?.folderId ? items.find((i) => i.item_id === resolved.folderId) : undefined;
  return {
    channelId,
    permissions: CHANNEL_PERMISSIONS,
    ...(await describeScope(resolved?.scopeId ?? null)),
    templates: await templateNames(),
    followsFolder: resolved?.followsFolder ?? false,
    folder: folder ? { id: folder.item_id, name: folder.label ?? null } : null,
  };
}

/** The scope `templateId` or `custom` names for something now on `current`.
    Undefined for a template that is not one; Custom reuses a private scope. */
async function chosenScope(
  current: string | null,
  payload: { templateId?: string | null; custom?: boolean; rules?: { roleId: string; permission: string; effect: string }[] },
): Promise<string | null | undefined> {
  if (payload.custom) {
    // Never a template id or a folder's scope: both are shared.
    const existing = current ? await getPermissionScope(current) : null;
    const scopeId = existing && !existing.is_template
      ? existing.scope_id
      : await createPermissionScope({ isTemplate: false });
    await replacePermissionRules(scopeId, payload.rules ?? []);
    return scopeId;
  }
  if (payload.templateId) {
    const template = await getPermissionScope(payload.templateId);
    return template?.is_template ? payload.templateId : undefined;
  }
  return null;
}

function broadcastDetails(ctx: HandlerContext) {
  const { io, clientsInfo, serverId } = ctx;
  for (const [sid, s] of io.sockets.sockets) {
    if (clientsInfo[sid]?.grytUserId) {
      sendServerDetails(s, clientsInfo, serverId).catch((e) => consola.warn("sendServerDetails failed", e));
    }
  }
  // Every caller moved a scope, a rule or a channel, so a call in progress may owe the SFU.
  void pushVoiceCapabilities();
}

export function registerAdminChannelHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, serverId, clientsInfo } = ctx;

  return {
    // ── Channels ─────────────────────────────────────────────────

    /** Needs `manage_channels`: signed-in alone hands any member the name and
        gate of every hidden channel. Unfiltered for whoever holds it. */
    'server:channels:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;
        const { channels: chans, scopes } = await resolvedScopesNow();
        socket.emit("server:channels", {
          serverId,
          channels: chans.map((c) => ({
            id: c.channel_id, name: c.name, type: c.type, description: c.description, position: c.position,
            requirePushToTalk: c.require_push_to_talk || false,
            disableRnnoise: c.disable_rnnoise || false,
            maxBitrate: c.max_bitrate ?? null,
            eSportsMode: c.esports_mode || false,
            textInVoice: c.text_in_voice || false,
            layout: c.layout,
            automated: c.automated || false,
            defaultNotificationLevel: channelNotificationLevel(c),
            forumTags: c.forum_tags,
            permissionScopeId: scopes.get(c.channel_id)?.scopeId ?? null,
            followsFolder: scopes.get(c.channel_id)?.followsFolder ?? false,
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
      layout?: "chat" | "forum"; automated?: boolean; forumTags?: ForumTag[];
      defaultNotificationLevel?: ChannelNotificationLevel | null;
      /** A new channel's folder, so its first row is there and it never shows
          outside it. Ignored for a channel that exists. */
      parentItemId?: string | null;
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

        /* A new channel needs a sidebar row or nobody sees it. An edit adds
           nothing, so a rename cannot undo one deliberately taken out. */
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
          layout: payload.layout,
          automated: payload.automated,
          forumTags: payload.forumTags,
          defaultNotificationLevel: payload.defaultNotificationLevel,
        });
        if (isNewChannel) {
          try {
            await addChannelRowIfMissing(channelId, payload.parentItemId ?? null);
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
        // Both caches hold this id, and a recreated channel would inherit the
        // deleted one's gate for fifteen seconds. Dropped together.
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

    /** Templates only: a channel's private "Custom" scope comes down with the
        channel in `…:scope:get`. */
    'server:permissions:templates:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;

        const [templates, rulesByScope, { scopes }] = await Promise.all([
          listPermissionTemplates(),
          listAllPermissionRules(),
          resolvedScopesNow(),
        ]);

        // Editing a template changes every channel using it at once, a folder's
        // included, so this is the number somebody wants before they touch a row.
        const usedBy = new Map<string, number>();
        for (const { scopeId } of scopes.values()) {
          if (!scopeId) continue;
          usedBy.set(scopeId, (usedBy.get(scopeId) ?? 0) + 1);
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

    /** `rules` is the whole matrix, not a patch: inherit is an absent cell, and
        patching would make it unreachable once anything was set. */
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

        // The one edit that can hide several channels at once. Cache first,
        // then evict, then tell everybody.
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

        // Channels and folders on it go to Everyone, which can only widen access.
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

    /** Choosing a scope is `manage_channels`; what a template says is policy and
        stays behind `manage_roles`. The names come without the rules. */
    'server:channels:scope:get': async (payload: { accessToken: string; channelId: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;
        if (!payload || typeof payload.channelId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "channelId required." });
          return;
        }

        socket.emit("server:channels:scope", { serverId, ...(await channelScopeReply(payload.channelId)) });
      } catch (e) {
        consola.error("server:channels:scope:get failed", e);
        socket.emit("server:error", { error: "scope_failed", message: "Failed to read channel permissions." });
      }
    },

    /** `templateId` picks a template, `custom: true` writes `rules` into the
        channel's private scope, neither is Everyone. Each is the channel's own. */
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

        // The channel's own scope, not its folder's: Custom from a folder copies
        // what it shows into a scope of the channel's own.
        const scopeId = await chosenScope(channel.permission_scope_id, payload);
        if (scopeId === undefined) {
          socket.emit("server:error", { error: "not_found", message: "No such template." });
          return;
        }
        await setChannelPermissionScope(channelId, scopeId);

        // Cache, then evict, then broadcast: off a stale cache the broadcast
        // names a channel that was just hidden.
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

    /** Back to whatever its folder says, dropping the scope it had. The reply is
        the dialog's: it is open on this channel and cannot know the folder's. */
    'server:channels:scope:follow': async (payload: { accessToken: string; channelId: string }) => {
      try {
        const rl = rlCheck("server:channels:scope:follow", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.channelId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "channelId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;

        const channelId = payload.channelId.trim();
        const channels = await listServerChannels();
        if (!channels.some((c) => c.channel_id === channelId)) {
          socket.emit("server:error", { error: "not_found", message: "No such channel." });
          return;
        }

        await setChannelPermissionScope(channelId, null, { followFolder: true });
        await refreshChannelAccess(ctx);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "channel_scope_follow", target: channelId }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:channels:scope", { serverId, ...(await channelScopeReply(channelId)) });
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:channels:scope:follow failed", e);
        socket.emit("server:error", { error: "scope_set_failed", message: "Failed to set channel permissions." });
      }
    },

    /** As `server:channels:scope:get`, for a folder. `channelCount` is how many
        of its channels follow it, so how many a change reaches. */
    'server:folders:scope:get': async (payload: { accessToken: string; folderId: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;
        if (!payload || typeof payload.folderId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "folderId required." });
          return;
        }

        const { items, scopes } = await resolvedScopesNow();
        const folder = items.find((i) => i.item_id === payload.folderId && i.kind === "folder");
        if (!folder) {
          socket.emit("server:error", { error: "not_found", message: "No such folder." });
          return;
        }
        const following = [...scopes.values()].filter((r) => r.followsFolder && r.folderId === folder.item_id);

        socket.emit("server:folders:scope", {
          serverId,
          folderId: folder.item_id,
          permissions: CHANNEL_PERMISSIONS,
          ...(await describeScope(folder.permission_scope_id)),
          templates: await templateNames(),
          channelCount: following.length,
        });
      } catch (e) {
        consola.error("server:folders:scope:get failed", e);
        socket.emit("server:error", { error: "scope_failed", message: "Failed to read folder permissions." });
      }
    },

    /** As `server:channels:scope:set`, for a folder, and so for every channel in
        it that follows it. */
    'server:folders:scope:set': async (payload: {
      accessToken: string;
      folderId: string;
      templateId?: string | null;
      custom?: boolean;
      rules?: { roleId: string; permission: string; effect: string }[];
    }) => {
      try {
        const rl = rlCheck("server:folders:scope:set", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.folderId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "folderId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "manage_channels" });
        if (!auth) return;

        const items = await listServerSidebarItems();
        const folder = items.find((i) => i.item_id === payload.folderId.trim() && i.kind === "folder");
        if (!folder) {
          socket.emit("server:error", { error: "not_found", message: "No such folder." });
          return;
        }

        const scopeId = await chosenScope(folder.permission_scope_id, payload);
        if (scopeId === undefined) {
          socket.emit("server:error", { error: "not_found", message: "No such template." });
          return;
        }
        await setFolderPermissionScope(folder.item_id, scopeId);

        await refreshChannelAccess(ctx);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "folder_scope_set", target: folder.item_id, meta: { templateId: payload.templateId ?? null, custom: Boolean(payload.custom) } }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:folders:scope:set failed", e);
        socket.emit("server:error", { error: "scope_set_failed", message: "Failed to set folder permissions." });
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
          // The full record, not just the position: upsertServerChannel sets
          // every column on conflict, so a partial one resets the rest.
          await upsertServerChannel({
            channelId: ch.channel_id, name: ch.name, type: ch.type, description: ch.description, position: pos,
            requirePushToTalk: ch.require_push_to_talk, disableRnnoise: ch.disable_rnnoise,
            maxBitrate: ch.max_bitrate, eSportsMode: ch.esports_mode, textInVoice: ch.text_in_voice,
            layout: ch.layout, automated: ch.automated, forumTags: ch.forum_tags,
            defaultNotificationLevel: ch.default_notification,
          });
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
        if (await ensureDefaultSidebarItems()) resetChannelPermissionCache();
        const { serverUserId, grytUserId } = auth.tokenPayload;
        const [all, visible, keepEmpty] = await Promise.all([
          listServerSidebarItems(),
          visibleChannelIds(serverUserId, grytUserId),
          keepsEmptyFolders(serverUserId, grytUserId),
        ]);
        // Filtered as `server:details` is: a hidden channel's row or a folder's
        // name must not reach somebody by asking here instead.
        const items = visibleSidebarItems(all, visible, keepEmpty);
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
      accessToken: string; itemId: string; kind: "channel" | "separator" | "spacer" | "folder";
      position?: number; channelId?: string | null; spacerHeight?: number | null; label?: string | null;
      parentItemId?: string | null;
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

        const now = await resolvedScopesNow();
        if (payload.kind === "channel" && payload.channelId) {
          const moves = [{ channelId: payload.channelId, parentItemId: payload.parentItemId ?? null }];
          if (movesChangeAccess(now, moves) && !requirePermission(socket, auth, "manage_channels")) return;
        }

        const before = now.scopes;
        await upsertServerSidebarItem({ itemId: payload.itemId, kind: payload.kind, position: payload.position, channelId: payload.channelId ?? null, spacerHeight: payload.spacerHeight ?? null, label: payload.label ?? null, parentItemId: payload.parentItemId ?? null });

        resetChannelPermissionCache();
        if (scopesDiffer(before, (await resolvedScopesNow()).scopes)) await refreshChannelAccess(ctx);
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

        const before = (await resolvedScopesNow()).scopes;
        await deleteServerSidebarItem(payload.itemId);
        resetChannelPermissionCache();
        if (scopesDiffer(before, (await resolvedScopesNow()).scopes)) await refreshChannelAccess(ctx);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_item_delete", target: payload.itemId }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:sidebar:item:delete failed", e);
        socket.emit("server:error", { error: "sidebar_delete_failed", message: "Failed to delete sidebar item." });
      }
    },

    /* One drag changes order and folder together. A bare id still has to pass
       `parent_item_id` through, or `upsert` empties every folder. */
    'server:sidebar:reorder': async (payload: {
      accessToken: string;
      order: (string | { itemId: string; parentItemId?: string | null })[];
    }) => {
      try {
        const rl = rlCheck("server:sidebar:reorder", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || !Array.isArray(payload.order)) {
          socket.emit("server:error", { error: "invalid_payload", message: "order required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "manage_sidebar" });
        if (!auth) return;

        const now = await resolvedScopesNow();
        const { items, scopes: before } = now;
        const byId = new Map(items.map((it) => [it.item_id, it]));
        const placed = payload.order.flatMap((entry) => {
          const isObject = typeof entry === "object" && entry !== null;
          const rawId = isObject ? entry.itemId : entry;
          const it = byId.get(String(rawId || "").trim());
          if (!it) return [];
          const parentItemId = isObject && "parentItemId" in entry
            ? entry.parentItemId ?? null
            : it.parent_item_id;
          return [{ it, parentItemId }];
        });

        const moves = placed
          .filter(({ it }) => it.kind === "channel" && it.channel_id)
          .map(({ it, parentItemId }) => ({ channelId: it.channel_id as string, parentItemId }));
        if (movesChangeAccess(now, moves) && !requirePermission(socket, auth, "manage_channels")) return;

        let pos = 10;
        for (const { it, parentItemId } of placed) {
          await upsertServerSidebarItem({ itemId: it.item_id, kind: it.kind, position: pos, channelId: it.channel_id, spacerHeight: it.spacer_height, label: it.label, parentItemId });
          pos += 10;
        }
        resetChannelPermissionCache();
        if (scopesDiffer(before, (await resolvedScopesNow()).scopes)) await refreshChannelAccess(ctx);
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "sidebar_reorder", meta: { order: payload.order } }).catch((e) => consola.warn("audit log write failed", e));
        broadcastDetails(ctx);
      } catch (e) {
        consola.error("server:sidebar:reorder failed", e);
        socket.emit("server:error", { error: "sidebar_reorder_failed", message: "Failed to reorder sidebar." });
      }
    },
  };
}
