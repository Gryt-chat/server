import consola from "consola";
import { getAcceptedIdentityTiers } from "../../auth/identity";
import { mayViewChannel } from "../../services/channelPermissions";
import {
  INVITE_ROLE_REFUSAL_TEXT,
  mayBindRoleToInvite,
} from "../../services/inviteRoles";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth, requireOutranks } from "../middleware/auth";
import { listRolesByMember } from "../../services/permissions";
import { broadcastServerUiUpdate, sendEmojiQueueStateToSocket } from "../utils/server";
import { applyServerSettings, settingsView } from "../../settings/serverSettings";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import {
  getServerConfig,
  createServerConfigIfNotExists,
  updateServerConfig,
  createServerInvite,
  listServerInvites,
  getServerInvite,
  revokeServerInvite,
  setServerRole,
  addMemberRole,
  removeMemberRole,
  listMemberRoles,
  listServerRoles,
  listRoleDefinitions,
  getRoleDefinition,
  createRoleDefinition,
  updateRoleDefinition,
  deleteRoleDefinition,
  countRoleHolders,
  insertServerAudit,
  listServerAudit,
  listJoinRequests,
  decideJoinRequest,
  banUser,
  unbanUser,
  listBans,
  getUserByServerId,
  purgeUserContent,
  setUserModerationState,
  listBots,
  getBotByRegistrationId,
  decideBot,
  createBotRegistration,
  updateBotGrant,
  deleteBotRegistration,
  normalizeBotName,
  normalizeBotDescription,
  getUserByGrytId,
} from "../../db";
import { deleteFilesNow } from "../../jobs/mediaSweep";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { evictUser, resolveGrytUserId } from "../../moderation/evict";
import { sfuRoomId } from "../utils/voiceRooms";
import { getVersionStatus } from "../../versionCheck";
import { registerAdminChannelHandlers } from "./adminChannels";
import {
  FALLBACK_ROLE_ID,
  isSystemRole,
  isValidRoleId,
  normalizePermissions,
  OWNER_ROLE_ID,
  PERMISSIONS,
} from "../../constants/permissions";

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
 * When a ban should lift. Anything unusable means permanent rather than
 * rejected — refusing a moderation action over a malformed duration fails the
 * wrong way.
 */
function resolveBanExpiry(expiresInMinutes?: number | null): Date | null {
  if (expiresInMinutes === undefined || expiresInMinutes === null) return null;
  const minutes = Math.floor(Number(expiresInMinutes));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(Date.now() + Math.min(minutes, MAX_BAN_MINUTES) * 60_000);
}

/** A day, in minutes. A longer silence is what an indefinite mute is for. */
const MAX_MUTE_MINUTES = 1440;

/** When a timed mute lifts. Absent or unusable means indefinite. */
function resolveMuteExpiry(expiresInMinutes?: number | null): Date | null {
  if (expiresInMinutes === undefined || expiresInMinutes === null) return null;
  const minutes = Math.floor(Number(expiresInMinutes));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(Date.now() + Math.min(minutes, MAX_MUTE_MINUTES) * 60_000);
}

/**
 * Tells the SFU what this user's audio should be doing. The room is
 * `${serverId}_${voiceChannelId}` and the user is the server user id — both
 * were once wrong here, so the call matched nothing and only a cooperating
 * client was ever muted. Mirrors the equivalent call in voice.ts.
 */
function pushSfuAudioState(
  sfuClient: HandlerContext["sfuClient"],
  serverId: string,
  ci: { serverUserId: string; hasJoinedChannel: boolean; voiceChannelId: string; isMuted: boolean; isDeafened: boolean; isServerMuted: boolean; isServerDeafened: boolean },
): void {
  if (!sfuClient || !ci.hasJoinedChannel || !ci.voiceChannelId) return;
  const roomId = sfuRoomId(serverId, ci.voiceChannelId);
  sfuClient
    .updateUserAudioState(
      roomId,
      ci.serverUserId,
      ci.isMuted || ci.isServerMuted,
      ci.isDeafened || ci.isServerDeafened,
    )
    .catch((e) => consola.error("Failed to update SFU audio state:", e));
}

/** `#rrggbb` only — the value goes straight into a style on every client. */
/**
 * `undefined` means leave it alone; anything that is not a positive number
 * becomes null, which is off. Capped because it arrives from a form.
 */
function normalizeThreshold(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), 1_000_000);
}

function normalizeRoleColor(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

/**
 * Everything the role editor needs. The permission catalogue rides along: an
 * older client would otherwise show a short list with no sign it was short,
 * and the editor saves the whole set, so the rest would be dropped.
 */
async function roleEditorState() {
  const [definitions, config] = await Promise.all([
    listRoleDefinitions(),
    getServerConfig(),
  ]);

  const roles = await Promise.all(
    definitions.map(async (r) => ({
      id: r.role_id,
      name: r.name,
      color: r.color,
      rank: r.rank,
      permissions: r.permissions,
      isSystem: r.is_system,
      autoGrantAfterDays: r.auto_grant_after_days,
      autoGrantAfterMessages: r.auto_grant_after_messages,
      grantableByInvite: r.grantable_by_invite,
      memberCount: await countRoleHolders(r.role_id),
    })),
  );

  return {
    roles,
    permissions: PERMISSIONS,
    defaults: {
      account: config?.default_role_account ?? FALLBACK_ROLE_ID,
      local: config?.default_role_local ?? FALLBACK_ROLE_ID,
    },
    /*
     * Which identities this server admits, so the editor can stop offering a
     * setting that does nothing (GRYT-907).
     *
     * The guest default only applies to somebody arriving with a self-signed
     * key, and `GRYT_IDENTITY_TIERS` decides whether anybody can. Without this
     * the editor had a live dropdown and a footnote underneath explaining that
     * the dropdown might not be used — which is a worse way of saying it than
     * turning the control off.
     *
     * Sent from the same place the rest of the editor's state comes from
     * rather than fetched separately: it is already on `/api/server-info` and
     * in the challenge, and a second round trip for one array is not worth the
     * extra failure mode.
     */
    identityTiers: getAcceptedIdentityTiers(),
  };
}

/**
 * `claim_token` is deliberately absent. It is shown once, in the reply to
 * `server:bots:register` — one that can be re-read lives as long as the list.
 */
async function botsView() {
  const [bots, cfg] = await Promise.all([listBots(), getServerConfig()]);
  return {
    // Whether a bot nobody has heard of may leave a knock. Sent with the list
    // rather than with the server settings, because it is the setting this
    // screen is about and an operator with `manage_bots` and nothing else
    // should be able to change it.
    policy: cfg?.bot_join_policy ?? "disabled",
    bots: bots.map((b) => ({
      registrationId: b.registration_id,
      botId: b.bot_id,
      nickname: b.nickname,
      description: b.description,
      requested: b.requested_permissions,
      granted: b.granted_permissions,
      rank: b.rank,
      status: b.status,
      // Whether it is still waiting for a bot to turn up and claim it.
      awaitingClaim: b.bot_id === null,
      createdAt: b.created_at,
      decidedAt: b.decided_at,
    })),
  };
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

  /**
   * Everything that has to be true before one member's roles are changed.
   * Three events share it, because one of them being a check short is a
   * privilege escalation rather than a cosmetic difference.
   */
  async function resolveRoleChange(
    event: string,
    payload: { accessToken: string; serverUserId: string; role: string },
    verb: string,
  ): Promise<{ targetId: string; roleId: string; actorId: string } | null> {
    const rl = rlCheck(event, ctx, RL_SETTINGS);
    if (!rl.allowed) { emitRateLimited(ctx, rl); return null; }

    if (!payload || typeof payload.serverUserId !== "string" || typeof payload.role !== "string") {
      socket.emit("server:error", { error: "invalid_payload", message: "serverUserId and role required." });
      return null;
    }

    const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
    if (!auth) return null;

    const roleId = payload.role.trim().toLowerCase();
    if (roleId === OWNER_ROLE_ID) {
      // The owner comes from server_config, and the row is a cache of it.
      // Handing it out here would write a row the resolver overrules.
      socket.emit("server:error", { error: "forbidden", message: "Owner role cannot be reassigned." });
      return null;
    }

    const definition = await getRoleDefinition(roleId);
    if (!definition) {
      socket.emit("server:error", { error: "unknown_role", message: `No such role: ${roleId}` });
      return null;
    }

    const targetId = payload.serverUserId.trim();
    // Outranking covers acting on yourself as well, so the old same-person
    // check is gone rather than duplicated.
    if (!(await requireOutranks(socket, auth, targetId, verb))) return null;

    // Granting a role you do not outrank is granting yourself a promotion one
    // step removed. Strictly below, matching `requireOutranks`, so an admin
    // cannot mint a second admin either. Applied to removal as well: the rank
    // you may not hand out is the rank you may not take away.
    if (definition.rank >= auth.rank) {
      socket.emit("server:error", {
        error: "forbidden",
        message: "Cannot grant a role at or above your own.",
      });
      return null;
    }

    return { targetId, roleId, actorId: auth.tokenPayload.serverUserId };
  }

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
        const view = settingsView(cfg, serverId, isOwner);

        // Every member receives this, and `systemChannelId` is a channel id —
        // naming a channel somebody cannot see undoes the rest of the work.
        // Blanked rather than refused, since the other settings are theirs.
        if (
          view.systemChannelId &&
          !(await mayViewChannel(view.systemChannelId, client.serverUserId, client.grytUserId))
        ) {
          view.systemChannelId = null;
        }

        socket.emit("server:settings", view);
      } catch (e) {
        consola.error("server:settings:get failed", e);
        socket.emit("server:error", { error: "settings_failed", message: "Failed to load settings." });
      }
    },

    "server:emojiQueue:get": async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_emojis" });
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
      joinPolicy?: string;
      discoverable?: boolean;
    }) => {
      try {
        const rl = rlCheck("server:settings:update", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_server" });
        if (!auth) return;

        // Validation, the row write and every side effect live in
        // settings/serverSettings.ts, because the management endpoint applies
        // the same change and two copies would drift on the first thing either
        // one forgot.
        const updated = await applyServerSettings(payload, {
          serverUserId: auth.tokenPayload.serverUserId,
          via: "client",
        });

        socket.emit("server:settings", settingsView(updated, serverId, true));
      } catch (e) {
        consola.error("server:settings:update failed", e);
        socket.emit("server:error", { error: "settings_update_failed", message: "Failed to update settings." });
      }
    },

    // ── Invites ──────────────────────────────────────────────────

    'server:invites:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_invites" });
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

    'server:invites:create': async (payload: { accessToken: string; infinite?: boolean; maxUses?: number; expiresInHours?: number; note?: string | null; customCode?: string | null; grantsRole?: string | null }) => {
      try {
        const rl = rlCheck("server:invites:create", ctx, RL_INVITE);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        const auth = await requireAuth(socket, payload, { permission: "create_invite" });
        if (!auth) return;

        const infinite = payload.infinite === true;
        const maxUses = infinite ? undefined : (typeof payload.maxUses === "number" ? payload.maxUses : 1);
        const expiresInHours = typeof payload.expiresInHours === "number" ? payload.expiresInHours : undefined;
        const expiresAt = typeof expiresInHours === "number" && expiresInHours > 0
          ? new Date(Date.now() + Math.min(expiresInHours, 24 * 365) * 3_600_000)
          : null;
        const customCode = typeof payload.customCode === "string" ? payload.customCode.trim() : null;

        // Binding a role needs more than the permission to make invites.
        // `create_invite` says you may open a door; it does not say what may
        // walk through it wearing what. So the role is checked against the
        // same rules a direct grant goes through, plus the actor's own rank.
        let grantedRole: { roleId: string; rank: number } | null = null;
        const wantsRole = typeof payload.grantsRole === "string" ? payload.grantsRole.trim().toLowerCase() : "";
        if (wantsRole) {
          if (!auth.permissions.has("manage_roles")) {
            socket.emit("server:error", { error: "forbidden", message: "Binding a role to an invite needs manage_roles." });
            return;
          }
          const def = await getRoleDefinition(wantsRole);
          const verdict = mayBindRoleToInvite(
            def && {
              roleId: def.role_id,
              rank: def.rank,
              permissions: def.permissions,
              grantableByInvite: def.grantable_by_invite,
            },
            auth.rank,
          );
          if (!verdict.ok) {
            socket.emit("server:error", {
              error: "role_not_bindable",
              message: `Cannot bind that role: ${INVITE_ROLE_REFUSAL_TEXT[verdict.reason!]}.`,
            });
            return;
          }
          grantedRole = { roleId: def!.role_id, rank: def!.rank };
        }

        const created = await createServerInvite(auth.tokenPayload.serverUserId, { infinite, maxUses, expiresAt, note: payload.note ?? null, customCode: customCode || null, grantedRole });
        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "invite_create", target: created.code, meta: { infinite, maxUses: created.max_uses, expiresAt: created.expires_at, grantsRole: created.granted_role_id, grantsRoleRank: created.granted_role_rank } }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("server:invite:created", {
          serverId,
          invite: { code: created.code, createdAt: created.created_at, expiresAt: created.expires_at, maxUses: created.max_uses, usesRemaining: created.uses_remaining, usesConsumed: created.uses_consumed, revoked: created.revoked, note: created.note, grantsRole: created.granted_role_id },
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
        const auth = await requireAuth(socket, payload, { permission: "manage_invites" });
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

    // ── Join requests ────────────────────────────────────────────
    //
    // Readable whatever the join policy is: switching away from `request`
    // should not hide a queue somebody is still owed a decision on.

    'server:joinRequests:list': async (payload: { accessToken: string }) => {
      try {
        const rl = rlCheck("server:joinRequests:list", ctx, RL_INVITE);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        const auth = await requireAuth(socket, payload, { permission: "manage_join_requests" });
        if (!auth) return;

        const requests = await listJoinRequests("pending");
        socket.emit("server:joinRequests", {
          serverId,
          requests: requests.map((r) => ({
            grytUserId: r.gryt_user_id,
            nickname: r.nickname,
            note: r.note,
            createdAt: r.created_at,
          })),
        });
      } catch (e) {
        consola.error("server:joinRequests:list failed", e);
        socket.emit("server:error", { error: "join_requests_failed", message: "Failed to load join requests." });
      }
    },

    'server:joinRequests:decide': async (payload: { accessToken: string; grytUserId: string; decision: string }) => {
      try {
        const rl = rlCheck("server:joinRequests:decide", ctx, RL_INVITE);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const decision = payload?.decision === "approved" || payload?.decision === "denied" ? payload.decision : null;
        if (!payload || typeof payload.grytUserId !== "string" || !decision) {
          socket.emit("server:error", { error: "invalid_payload", message: "grytUserId and decision are required." });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "manage_join_requests" });
        if (!auth) return;

        const decided = await decideJoinRequest(payload.grytUserId.trim(), decision, auth.tokenPayload.serverUserId);
        if (!decided) {
          socket.emit("server:error", { error: "join_request_missing", message: "No such join request." });
          return;
        }

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: decision === "approved" ? "join_request_approve" : "join_request_deny",
          target: decided.gryt_user_id,
          meta: { nickname: decided.nickname },
        }).catch((e) => consola.warn("audit log write failed", e));

        // Everyone who can act on the queue sees it change, not just whoever
        // clicked — two moderators looking at the same list should not both be
        // deciding the same person.
        broadcastServerUiUpdate();
        socket.emit("server:joinRequest:decided", {
          serverId,
          grytUserId: decided.gryt_user_id,
          decision,
        });
      } catch (e) {
        consola.error("server:joinRequests:decide failed", e);
        socket.emit("server:error", { error: "join_request_decide_failed", message: "Failed to decide join request." });
      }
    },

    // ── Roles ────────────────────────────────────────────────────

    'server:roles:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;
        // One entry per member rather than one per row. A client that keys a
        // map by member and takes the last row it sees would otherwise show
        // whichever role was granted most recently, which is not the one the
        // member list draws.
        const byMember = await listRolesByMember();
        const updatedAt = new Map(
          (await listServerRoles()).map((r) => [r.server_user_id, r.updated_at]),
        );
        socket.emit("server:roles", {
          serverId,
          roles: [...byMember].map(([serverUserId, held]) => ({
            serverUserId,
            role: held[0],
            roles: held,
            updatedAt: updatedAt.get(serverUserId),
          })),
        });
      } catch (e) {
        consola.error("server:roles:list failed", e);
        socket.emit("server:error", { error: "roles_failed", message: "Failed to list roles." });
      }
    },

    /* Replace everything somebody holds with this one role — a demotion. */
    'server:roles:set': async (payload: { accessToken: string; serverUserId: string; role: string }) => {
      try {
        const change = await resolveRoleChange("server:roles:set", payload, "change the role of");
        if (!change) return;

        const { targetId, roleId: nextRole } = change;
        await setServerRole(targetId, nextRole);
        insertServerAudit({ actorServerUserId: change.actorId, action: "role_set", target: targetId, meta: { role: nextRole } }).catch((e) => consola.warn("audit log write failed", e));
        io.to("verifiedClients").emit("server:role:updated", { serverId, serverUserId: targetId, role: nextRole, roles: await listMemberRoles(targetId) });
        // The target's own permission list is part of server details, so it has
        // to be re-sent — otherwise a demotion only takes effect on their next
        // reconnect, and the UI keeps offering what the server now refuses.
        broadcastServerUiUpdate("other");
      } catch (e) {
        consola.error("server:roles:set failed", e);
        socket.emit("server:error", { error: "roles_update_failed", message: "Failed to update role." });
      }
    },

    /*
     * Give somebody a role without taking away the ones they have. Same gates
     * as set: an operator who can add a role they do not outrank can promote
     * themselves one step removed.
     */
    'server:roles:add': async (payload: { accessToken: string; serverUserId: string; role: string }) => {
      try {
        const change = await resolveRoleChange("server:roles:add", payload, "give a role to");
        if (!change) return;

        await addMemberRole(change.targetId, change.roleId);
        insertServerAudit({ actorServerUserId: change.actorId, action: "role_add", target: change.targetId, meta: { role: change.roleId } }).catch((e) => consola.warn("audit log write failed", e));

        const held = await listMemberRoles(change.targetId);
        io.to("verifiedClients").emit("server:role:updated", { serverId, serverUserId: change.targetId, role: held[0] ?? change.roleId, roles: held });
        broadcastServerUiUpdate("other");
      } catch (e) {
        consola.error("server:roles:add failed", e);
        socket.emit("server:error", { error: "roles_update_failed", message: "Failed to update role." });
      }
    },

    /*
     * Take one role away. Removing the last is allowed: it leaves them on the
     * joiner default for their tier, not on nothing.
     */
    'server:roles:remove': async (payload: { accessToken: string; serverUserId: string; role: string }) => {
      try {
        const change = await resolveRoleChange("server:roles:remove", payload, "take a role from");
        if (!change) return;

        await removeMemberRole(change.targetId, change.roleId);
        insertServerAudit({ actorServerUserId: change.actorId, action: "role_remove", target: change.targetId, meta: { role: change.roleId } }).catch((e) => consola.warn("audit log write failed", e));

        const held = await listMemberRoles(change.targetId);
        io.to("verifiedClients").emit("server:role:updated", { serverId, serverUserId: change.targetId, role: held[0] ?? FALLBACK_ROLE_ID, roles: held });
        broadcastServerUiUpdate("other");
      } catch (e) {
        consola.error("server:roles:remove failed", e);
        socket.emit("server:error", { error: "roles_update_failed", message: "Failed to update role." });
      }
    },

    // ── Role definitions ─────────────────────────────────────────
    //
    // What a role *is*, as opposed to who holds one. Gated on `manage_roles`,
    // which by default only the owner has — see the note on ADMIN_PERMISSIONS.

    'server:roles:definitions:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;
        socket.emit("server:roles:definitions", await roleEditorState());
      } catch (e) {
        consola.error("server:roles:definitions:list failed", e);
        socket.emit("server:error", { error: "roles_failed", message: "Failed to load roles." });
      }
    },

    /** Create a role, or edit one — the editor does not know which it is doing. */
    'server:roles:definitions:save': async (payload: {
      accessToken: string;
      roleId: string;
      name?: string;
      color?: string | null;
      rank?: number;
      permissions?: string[];
      autoGrantAfterDays?: number | null;
      autoGrantAfterMessages?: number | null;
      grantableByInvite?: boolean;
    }) => {
      try {
        const rl = rlCheck("server:roles:definitions:save", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;

        const roleId = String(payload?.roleId || "").trim().toLowerCase();
        if (!isValidRoleId(roleId)) {
          socket.emit("server:error", {
            error: "invalid_payload",
            message: "Role id must be lowercase letters, numbers, dashes or underscores.",
          });
          return;
        }

        const existing = await getRoleDefinition(roleId);

        /*
         * The owner role is what the fail-open path in services/permissions
         * falls back to, and it is the only thing standing between a mistake in
         * this editor and a server nobody can administer. Its name, rank and
         * permissions stay unwritable for that reason.
         *
         * **Its colour is not part of that** (GRYT-906). A colour cannot lock
         * anybody out, cannot move anybody above anybody, and cannot grant
         * anything. Refusing it was the blanket rule catching something the
         * rule was not written for.
         *
         * Before the two rank checks below, and that is not incidental: the
         * owner role's rank is the owner's own, so `existing.rank >= auth.rank`
         * refuses the owner editing their own role.
         *
         * Which is why this needs its own gate. `manage_roles` alone would let
         * a delegated admin recolour the owner so the owner reads as an
         * ordinary member — small, but social engineering for no benefit. Rank
         * is the check the rest of this file uses for "you are not above this",
         * and it is the one used here.
         */
        if (roleId === OWNER_ROLE_ID) {
          const colourOnly =
            payload?.color !== undefined &&
            payload?.name === undefined &&
            payload?.rank === undefined &&
            payload?.permissions === undefined &&
            payload?.autoGrantAfterDays === undefined &&
            payload?.autoGrantAfterMessages === undefined &&
            payload?.grantableByInvite === undefined;

          if (!colourOnly || !existing) {
            socket.emit("server:error", {
              error: "forbidden",
              message: "Only the owner role's colour can be changed.",
            });
            return;
          }

          if (auth.rank < existing.rank) {
            socket.emit("server:error", {
              error: "forbidden",
              message: "Cannot edit a role at or above your own.",
            });
            return;
          }

          const saved = await updateRoleDefinition(roleId, {
            name: existing.name,
            color: normalizeRoleColor(payload?.color, existing.color ?? null),
            rank: existing.rank,
            permissions: existing.permissions,
            autoGrantAfterDays: existing.auto_grant_after_days,
            autoGrantAfterMessages: existing.auto_grant_after_messages,
            grantableByInvite: existing.grantable_by_invite,
          });

          // Null means the row went between the read and the write. Nothing to
          // broadcast, and a client told a role updated when it did not would
          // draw a colour the server does not hold.
          if (!saved) {
            socket.emit("server:error", { error: "roles_failed", message: "Failed to save the role." });
            return;
          }

          insertServerAudit({
            actorServerUserId: auth.tokenPayload.serverUserId,
            action: "role_definition_update",
            target: roleId,
            meta: { color: saved.color },
          }).catch((e) => consola.warn("audit log write failed", e));

          io.to("verifiedClients").emit("server:roles:definition:updated", { serverId, role: saved });
          broadcastServerUiUpdate("other");
          return;
        }

        const name = typeof payload?.name === "string" ? payload.name.trim().slice(0, 32) : existing?.name;
        if (!name) {
          socket.emit("server:error", { error: "invalid_payload", message: "A role needs a name." });
          return;
        }

        const color = normalizeRoleColor(payload?.color, existing?.color ?? null);

        const rank = Number.isFinite(payload?.rank)
          ? Math.max(0, Math.min(99, Math.round(Number(payload?.rank))))
          : existing?.rank ?? 0;

        // Nobody may create or raise a role to their own level. Without this an
        // admin with `manage_roles` could define "superadmin" at rank 99 and
        // hand it to a friend, and the outranks checks would then work exactly
        // as designed against the owner.
        if (rank >= auth.rank) {
          socket.emit("server:error", {
            error: "forbidden",
            message: "Cannot create or move a role to your own rank or above.",
          });
          return;
        }
        if (existing && existing.rank >= auth.rank) {
          socket.emit("server:error", {
            error: "forbidden",
            message: "Cannot edit a role at or above your own.",
          });
          return;
        }

        const permissions = payload?.permissions
          ? normalizePermissions(payload.permissions)
          : existing?.permissions ?? [];

        // Same argument as the rank check, for capability rather than
        // hierarchy: you cannot put a permission into a role that you do not
        // hold yourself. The owner holds everything, so this only ever binds
        // somebody the owner has delegated to.
        const overreach = permissions.filter((perm) => !auth.permissions.has(perm));
        if (overreach.length > 0) {
          socket.emit("server:error", {
            error: "forbidden",
            message: `Cannot grant permissions you do not have: ${overreach.join(", ")}`,
          });
          return;
        }

        // A role that hands itself out is a role nobody reviews before it takes
        // effect, so the same two rules apply as to granting it by hand: it
        // cannot reach your own rank, and it cannot carry a permission you do
        // not hold. Both are already checked above, on the way in.
        const autoGrantAfterDays = normalizeThreshold(payload?.autoGrantAfterDays);
        const autoGrantAfterMessages = normalizeThreshold(payload?.autoGrantAfterMessages);

        // The tick that lets an invite hand this role out. Refused for the same
        // reasons an invite could not be bound to it, checked here so the flag
        // can never be set on a role that would fail at binding time — a tick
        // that saves and then never works is worse than a tick that refuses.
        let grantableByInvite = existing?.grantable_by_invite ?? false;
        if (typeof payload?.grantableByInvite === "boolean") {
          grantableByInvite = payload.grantableByInvite;
          if (grantableByInvite) {
            const verdict = mayBindRoleToInvite(
              { roleId, rank, permissions, grantableByInvite: true },
              auth.rank,
            );
            if (!verdict.ok) {
              socket.emit("server:error", {
                error: "role_not_bindable",
                message: `Cannot make that role invite-grantable: ${INVITE_ROLE_REFUSAL_TEXT[verdict.reason!]}.`,
              });
              return;
            }
          }
        }

        const saved = existing
          ? await updateRoleDefinition(roleId, {
              name,
              color,
              rank,
              permissions,
              autoGrantAfterDays,
              autoGrantAfterMessages,
              grantableByInvite,
            })
          : await createRoleDefinition(roleId, {
              name,
              color,
              rank,
              permissions,
              autoGrantAfterDays,
              autoGrantAfterMessages,
              grantableByInvite,
            });

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: existing ? "role_definition_update" : "role_definition_create",
          target: roleId,
          meta: { name, rank, permissions, autoGrantAfterDays, autoGrantAfterMessages, grantableByInvite },
        }).catch((e) => consola.warn("audit log write failed", e));

        io.to("verifiedClients").emit("server:roles:definition:updated", { serverId, role: saved });
        broadcastServerUiUpdate("other");
      } catch (e) {
        consola.error("server:roles:definitions:save failed", e);
        socket.emit("server:error", { error: "roles_update_failed", message: "Failed to save role." });
      }
    },

    'server:roles:definitions:delete': async (payload: {
      accessToken: string;
      roleId: string;
      reassignTo?: string;
    }) => {
      try {
        const rl = rlCheck("server:roles:definitions:delete", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;

        const roleId = String(payload?.roleId || "").trim().toLowerCase();
        if (isSystemRole(roleId)) {
          socket.emit("server:error", {
            error: "forbidden",
            // Saying why, because the seeder would silently put the row back on
            // the next restart and a delete that undoes itself is worse than a
            // refusal.
            message: "Built-in roles cannot be deleted. Edit their permissions instead.",
          });
          return;
        }

        const existing = await getRoleDefinition(roleId);
        if (!existing) {
          socket.emit("server:error", { error: "unknown_role", message: `No such role: ${roleId}` });
          return;
        }
        if (existing.rank >= auth.rank) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot delete a role at or above your own." });
          return;
        }

        const cfg = await getServerConfig();
        const requested = String(payload?.reassignTo || "").trim().toLowerCase();
        const reassignTo = (await getRoleDefinition(requested))
          ? requested
          : cfg?.default_role_account || FALLBACK_ROLE_ID;

        const { moved } = await deleteRoleDefinition(roleId, reassignTo);

        // A default that pointed at the role just deleted would leave every
        // future joiner resolving to the fallback, which is a permission change
        // nobody asked for and nothing in the UI would show.
        const defaultsPatch: { defaultRoleAccount?: string; defaultRoleLocal?: string } = {};
        if (cfg?.default_role_account === roleId) defaultsPatch.defaultRoleAccount = reassignTo;
        if (cfg?.default_role_local === roleId) defaultsPatch.defaultRoleLocal = reassignTo;
        if (Object.keys(defaultsPatch).length > 0) await updateServerConfig(defaultsPatch);

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "role_definition_delete",
          target: roleId,
          meta: { reassignTo, moved },
        }).catch((e) => consola.warn("audit log write failed", e));

        io.to("verifiedClients").emit("server:roles:definition:deleted", { serverId, roleId, reassignTo, moved });
        broadcastServerUiUpdate("other");
      } catch (e) {
        consola.error("server:roles:definitions:delete failed", e);
        socket.emit("server:error", { error: "roles_update_failed", message: "Failed to delete role." });
      }
    },

    /** Which role people land on when they join, per identity tier. */
    'server:roles:defaults:set': async (payload: {
      accessToken: string;
      accountRoleId?: string;
      localRoleId?: string;
    }) => {
      try {
        const rl = rlCheck("server:roles:defaults:set", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_roles" });
        if (!auth) return;

        const patch: { defaultRoleAccount?: string; defaultRoleLocal?: string } = {};

        for (const [key, field] of [
          ["accountRoleId", "defaultRoleAccount"],
          ["localRoleId", "defaultRoleLocal"],
        ] as const) {
          const raw = (payload as Record<string, unknown>)[key];
          if (raw === undefined) continue;
          const roleId = String(raw || "").trim().toLowerCase();
          const definition = await getRoleDefinition(roleId);
          if (!definition) {
            socket.emit("server:error", { error: "unknown_role", message: `No such role: ${roleId}` });
            return;
          }
          // A default nobody may grant by hand should not be reachable by
          // walking in the front door either.
          if (roleId === OWNER_ROLE_ID || definition.rank >= auth.rank) {
            socket.emit("server:error", {
              error: "forbidden",
              message: "Cannot make a role at or above your own the joining default.",
            });
            return;
          }
          patch[field] = roleId;
        }

        if (Object.keys(patch).length === 0) {
          socket.emit("server:error", { error: "invalid_payload", message: "Nothing to change." });
          return;
        }

        await updateServerConfig(patch);
        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "role_defaults_set",
          target: null,
          meta: patch,
        }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("server:roles:definitions", await roleEditorState());
      } catch (e) {
        consola.error("server:roles:defaults:set failed", e);
        socket.emit("server:error", { error: "roles_update_failed", message: "Failed to set joining defaults." });
      }
    },

    // ── Bots ─────────────────────────────────────────────────────
    //
    // All behind `manage_bots`, which by default only the owner has. Approving
    // a bot grants permissions to something nobody in the room can vouch for.

    'server:bots:list': async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "manage_bots" });
        if (!auth) return;
        socket.emit("server:bots", await botsView());
      } catch (e) {
        consola.error("server:bots:list failed", e);
        socket.emit("server:error", { error: "bots_failed", message: "Failed to load bots." });
      }
    },

    /**
     * Answer a bot that knocked. The registry intersects what the operator
     * ticked with what the bot asked for, so "approve" is never a blank cheque.
     */
    'server:bots:decide': async (payload: {
      accessToken: string;
      botId: string;
      decision: string;
      permissions?: string[];
      rank?: number;
    }) => {
      try {
        const rl = rlCheck("server:bots:decide", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const decision = payload?.decision === "approved" || payload?.decision === "denied"
          ? payload.decision
          : null;
        if (!payload || typeof payload.botId !== "string" || !decision) {
          socket.emit("server:error", { error: "invalid_payload", message: "botId and decision are required." });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "manage_bots" });
        if (!auth) return;

        const wanted = normalizePermissions(payload.permissions ?? []);
        const overreach = wanted.filter((p) => !auth.permissions.has(p));
        if (overreach.length > 0) {
          // The same rule as role editing. Somebody delegated `manage_bots`
          // must not be able to route around their own ceiling by approving a
          // bot that asked for more than they hold.
          socket.emit("server:error", {
            error: "forbidden",
            message: `Cannot grant permissions you do not have: ${overreach.join(", ")}`,
          });
          return;
        }

        const rank = Number.isFinite(payload.rank) ? Number(payload.rank) : 0;
        if (rank >= auth.rank) {
          socket.emit("server:error", {
            error: "forbidden",
            message: "Cannot give a bot your own rank or above.",
          });
          return;
        }

        const decided = await decideBot(payload.botId.trim(), decision, auth.tokenPayload.serverUserId, wanted, rank);
        if (!decided) {
          socket.emit("server:error", { error: "bot_missing", message: "No such bot." });
          return;
        }

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: decision === "approved" ? "bot_approve" : "bot_deny",
          target: decided.bot_id,
          meta: { nickname: decided.nickname, granted: decided.granted_permissions, rank: decided.rank },
        }).catch((e) => consola.warn("audit log write failed", e));

        io.to("verifiedClients").emit("server:bot:updated", { serverId, botId: decided.bot_id });
        broadcastServerUiUpdate("other");
        socket.emit("server:bots", await botsView());
      } catch (e) {
        consola.error("server:bots:decide failed", e);
        socket.emit("server:error", { error: "bots_failed", message: "Failed to answer the bot." });
      }
    },

    /**
     * Write down what a bot may do before there is a bot. The token is shown
     * once, here.
     */
    'server:bots:register': async (payload: {
      accessToken: string;
      nickname: string;
      description?: string;
      permissions?: string[];
      rank?: number;
    }) => {
      try {
        const rl = rlCheck("server:bots:register", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_bots" });
        if (!auth) return;

        const wanted = normalizePermissions(payload?.permissions ?? []);
        const overreach = wanted.filter((p) => !auth.permissions.has(p));
        if (overreach.length > 0) {
          socket.emit("server:error", {
            error: "forbidden",
            message: `Cannot grant permissions you do not have: ${overreach.join(", ")}`,
          });
          return;
        }

        const rank = Number.isFinite(payload?.rank) ? Number(payload.rank) : 0;
        if (rank >= auth.rank) {
          socket.emit("server:error", { error: "forbidden", message: "Cannot give a bot your own rank or above." });
          return;
        }

        const created = await createBotRegistration({
          nickname: normalizeBotName(payload?.nickname),
          description: normalizeBotDescription(payload?.description),
          grantedPermissions: wanted,
          rank,
          createdByServerUserId: auth.tokenPayload.serverUserId,
        });

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "bot_register",
          target: created.registration_id,
          meta: { nickname: created.nickname, granted: created.granted_permissions, rank: created.rank },
        }).catch((e) => consola.warn("audit log write failed", e));

        // The only time the token is ever sent anywhere. `botsView` never
        // includes it, so reopening the tab will not show it again.
        socket.emit("server:bot:registered", {
          serverId,
          registrationId: created.registration_id,
          nickname: created.nickname,
          claimToken: created.claim_token,
        });
        socket.emit("server:bots", await botsView());
      } catch (e) {
        consola.error("server:bots:register failed", e);
        socket.emit("server:error", { error: "bots_failed", message: "Failed to create the bot." });
      }
    },

    'server:bots:update': async (payload: {
      accessToken: string;
      registrationId: string;
      permissions?: string[];
      rank?: number;
    }) => {
      try {
        const rl = rlCheck("server:bots:update", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_bots" });
        if (!auth) return;
        if (typeof payload?.registrationId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "registrationId is required." });
          return;
        }

        const wanted = normalizePermissions(payload.permissions ?? []);
        const overreach = wanted.filter((p) => !auth.permissions.has(p));
        if (overreach.length > 0) {
          socket.emit("server:error", {
            error: "forbidden",
            message: `Cannot grant permissions you do not have: ${overreach.join(", ")}`,
          });
          return;
        }

        const updated = await updateBotGrant(payload.registrationId.trim(), wanted, payload.rank);
        if (!updated) {
          socket.emit("server:error", { error: "bot_missing", message: "No such bot." });
          return;
        }

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "bot_update",
          target: updated.registration_id,
          meta: { granted: updated.granted_permissions, rank: updated.rank },
        }).catch((e) => consola.warn("audit log write failed", e));

        broadcastServerUiUpdate("other");
        socket.emit("server:bots", await botsView());
      } catch (e) {
        consola.error("server:bots:update failed", e);
        socket.emit("server:error", { error: "bots_failed", message: "Failed to update the bot." });
      }
    },

    /**
     * Withdraw a bot's registration. Takes effect at the next thing it tries —
     * standing is resolved from the registry on every check. The membership row
     * is left alone; removing that is a kick or a ban.
     */
    'server:bots:revoke': async (payload: { accessToken: string; registrationId: string }) => {
      try {
        const rl = rlCheck("server:bots:revoke", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_bots" });
        if (!auth) return;
        if (typeof payload?.registrationId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "registrationId is required." });
          return;
        }

        const existing = await getBotByRegistrationId(payload.registrationId.trim());
        const removed = await deleteBotRegistration(payload.registrationId.trim());
        if (!removed) {
          socket.emit("server:error", { error: "bot_missing", message: "No such bot." });
          return;
        }

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "bot_revoke",
          target: existing?.bot_id ?? payload.registrationId.trim(),
          meta: { nickname: existing?.nickname ?? null },
        }).catch((e) => consola.warn("audit log write failed", e));

        // Withdrawing permission and removing the member are two things, and an
        // operator clicking Revoke means both. The permission half already took
        // effect the moment the row went — standing is read from the registry on
        // every check, so there is no grant left to expire.
        if (existing?.bot_id) {
          const member = await getUserByGrytId(existing.bot_id).catch(() => null);
          if (member) {
            await evictUser({
              io,
              clientsInfo,
              serverId,
              sfuClient,
              targetServerUserId: member.server_user_id,
              targetGrytUserId: existing.bot_id,
              action: "kick",
              reason: "Bot registration withdrawn",
            }).catch((e) => consola.warn("evicting revoked bot failed", e));
          }
        }

        broadcastServerUiUpdate("other");
        socket.emit("server:bots", await botsView());
      } catch (e) {
        consola.error("server:bots:revoke failed", e);
        socket.emit("server:error", { error: "bots_failed", message: "Failed to revoke the bot." });
      }
    },

    'server:bots:policy:set': async (payload: { accessToken: string; policy: string }) => {
      try {
        const rl = rlCheck("server:bots:policy:set", ctx, RL_SETTINGS);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }

        const auth = await requireAuth(socket, payload, { permission: "manage_bots" });
        if (!auth) return;

        const policy = payload?.policy === "request" ? "request" : "disabled";
        await updateServerConfig({ botJoinPolicy: policy });

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: "bot_policy_set",
          target: null,
          meta: { policy },
        }).catch((e) => consola.warn("audit log write failed", e));

        socket.emit("server:bots", await botsView());
      } catch (e) {
        consola.error("server:bots:policy:set failed", e);
        socket.emit("server:error", { error: "bots_failed", message: "Failed to change the setting." });
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
        const auth = await requireAuth(socket, payload, { permission: "kick_members" });
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
          serverId,
          sfuClient,
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

    /**
     * How a member got in, for the moderator about to remove them. Asked for by
     * id rather than broadcast: the member list goes to everybody, and an
     * invite code in it would let any member collect working codes.
     */
    'server:member:invite': async (payload: { accessToken: string; targetServerUserId?: string }) => {
      try {
        const auth = await requireAuth(socket, payload, { permission: "create_invite" });
        if (!auth) return;

        const targetId = typeof payload?.targetServerUserId === "string" ? payload.targetServerUserId.trim() : "";
        if (!targetId) {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId required." });
          return;
        }

        const target = await getUserByServerId(targetId);
        const code = target?.joined_with_invite_code ?? null;
        const invite = code ? await getServerInvite(code) : null;

        socket.emit("server:member:invite", {
          targetServerUserId: targetId,
          code,
          // Absent means they did not arrive on an invite at all — the first
          // member claims the server, and a LAN or open join needs no code.
          active: invite ? !invite.revoked : false,
          usesConsumed: invite?.uses_consumed ?? 0,
          maxUses: invite?.max_uses ?? 0,
        });
      } catch (e) {
        consola.error("server:member:invite failed", e);
        socket.emit("server:error", { error: "member_invite_failed", message: "Could not look that up." });
      }
    },

    'server:ban': async (payload: { accessToken: string; targetServerUserId: string; reason?: string; expiresInMinutes?: number | null; deleteContent?: boolean; revokeInvite?: boolean }) => {
      try {
        const rl = rlCheck("server:ban", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "ban_members" });
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
          serverId,
          sfuClient,
          targetServerUserId: targetId,
          targetGrytUserId,
          action: "ban",
          reason: payload.reason,
        });

        // Erase what they wrote, if asked. A choice rather than automatic:
        // unban restores access and cannot restore a thread.
        const purge = payload.deleteContent !== false;
        if (purge) {
          const { deletedMessages, updatedReactions, orphanedAttachmentIds } =
            await purgeUserContent(targetId);

          // Straight away rather than on the next sweep (GRYT-139). A ban with
          // purge is usually reached for because of what somebody posted, and
          // the sweep's grace period is measured from upload — so it protects
          // the newest files, which are exactly the ones being removed.
          const files = await deleteFilesNow(orphanedAttachmentIds);

          const affectedConversations = [...new Set(deletedMessages.map((d) => d.conversation_id))];
          io.emit("chat:purge_user", {
            sender_server_user_id: targetId,
            affected_conversations: affectedConversations,
          });
          // No per-message broadcast for their reactions: the client holds
          // those messages and strips the id from the purge event itself.
          consola.info(
            `Purged ${deletedMessages.length} messages, ${updatedReactions.length} reactions and ${files.deleted} file(s) for ${targetId}`,
          );
        }

        // Close the door they came through, if asked. A ban is keyed on the
        // identity, and one with no account behind it costs seconds to replace
        // — so a banned user can return on the same invite. This does not make
        // the ban durable; it closes the forgotten-live-link case.
        let revokedInvite: string | null = null;
        if (payload.revokeInvite) {
          try {
            const target = await getUserByServerId(targetId);
            const code = target?.joined_with_invite_code;
            if (code) {
              const invite = await getServerInvite(code);
              // Skipped rather than re-revoked, so the audit log does not claim
              // an action that changed nothing.
              if (invite && !invite.revoked) {
                await revokeServerInvite(code);
                revokedInvite = code;
                io.to("verifiedClients").emit("server:invite:revoked", { serverId, code, revoked: true });
              }
            }
          } catch (e) {
            // The ban itself has already happened and is the important half.
            consola.warn("Could not revoke the invite used by a banned user:", e);
          }
        }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: "ban", target: targetId, meta: { reason: payload.reason ?? null, deletedContent: purge, revokedInvite } }).catch((e) => consola.warn("audit log write failed", e));
        socket.emit("server:ban:success", { targetServerUserId: targetId, revokedInvite });
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

        const auth = await requireAuth(socket, payload, { permission: "ban_members" });
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
        const auth = await requireAuth(socket, payload, { permission: "view_bans" });
        if (!auth) return;
        const bans = await listBans();
        socket.emit("server:bans", { serverId, bans });
      } catch (e) {
        consola.error("server:bans:list failed", e);
        socket.emit("server:error", { error: "bans_failed", message: "Failed to list bans." });
      }
    },

    'server:mute': async (payload: { accessToken: string; targetServerUserId: string; muted: boolean; expiresInMinutes?: number | null }) => {
      try {
        const rl = rlCheck("server:mute", ctx, RL_MODERATION);
        if (!rl.allowed) { emitRateLimited(ctx, rl); return; }
        if (!payload || typeof payload.targetServerUserId !== "string" || typeof payload.muted !== "boolean") {
          socket.emit("server:error", { error: "invalid_payload", message: "targetServerUserId and muted required." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "mute_members" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (!(await requireOutranks(socket, auth, targetId, "server-mute"))) return;

        // The row is the source of truth now. The in-memory flag below is a
        // cache of it for the sockets that are already connected; without the
        // write, reconnecting cleared the mute.
        const mutedUntil = resolveMuteExpiry(payload.expiresInMinutes);
        await setUserModerationState(targetId, { muted: payload.muted, mutedUntil });

        for (const [sid, s] of io.sockets.sockets) {
          const ci = clientsInfo[sid];
          if (ci?.serverUserId === targetId) {
            ci.isServerMuted = payload.muted;
            s.emit("server:muted", { muted: payload.muted, expiresAt: mutedUntil?.toISOString() ?? null });
            pushSfuAudioState(sfuClient, serverId, ci);
          }
        }

        insertServerAudit({ actorServerUserId: auth.tokenPayload.serverUserId, action: payload.muted ? "server_mute" : "server_unmute", target: targetId, meta: { expiresAt: mutedUntil?.toISOString() ?? null } }).catch((e) => consola.warn("audit log write failed", e));
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
        const auth = await requireAuth(socket, payload, { permission: "deafen_members" });
        if (!auth) return;

        const targetId = payload.targetServerUserId.trim();
        if (!(await requireOutranks(socket, auth, targetId, "server-deafen"))) return;

        await setUserModerationState(targetId, { deafened: payload.deafened });

        for (const [sid, s] of io.sockets.sockets) {
          const ci = clientsInfo[sid];
          if (ci?.serverUserId === targetId) {
            ci.isServerDeafened = payload.deafened;
            s.emit("server:deafened", { deafened: payload.deafened });
            pushSfuAudioState(sfuClient, serverId, ci);
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
        const auth = await requireAuth(socket, payload, { permission: "replace_identity" });
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
        const auth = await requireAuth(socket, payload, { permission: "view_audit_log" });
        if (!auth) return;
        const limit = typeof payload.limit === "number" ? payload.limit : 50;
        const before = typeof payload.before === "string" ? new Date(payload.before) : undefined;
        const items = await listServerAudit(limit, before && Number.isFinite(before.getTime()) ? before : undefined);

        // Rank does not gate the audit log, so an auditor holding nothing but
        // `view_audit_log` would otherwise read a hidden channel's id out of
        // `target` and its name out of `meta`. Rows are dropped whole rather
        // than redacted, because a redacted row still says one exists.
        // mayViewChannel answers true for non-channel targets and reads a
        // cache, so the per-row call is cheap.
        const allowed = await Promise.all(
          items.map((it) =>
            it.target
              ? mayViewChannel(it.target, auth.tokenPayload.serverUserId, auth.tokenPayload.grytUserId)
              : Promise.resolve(true),
          ),
        );
        const readable = items.filter((_, i) => allowed[i]);

        socket.emit("server:audit", {
          serverId,
          items: readable.map((it) => ({
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
        const auth = await requireAuth(socket, payload, { permission: "view_server_status" });
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
