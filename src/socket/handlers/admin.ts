import consola from "consola";
import { mayViewChannel } from "../../services/channelPermissions";
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
 * Tells the SFU what this user's audio should be doing.
 *
 * Both arguments used to be wrong here. The room was built as
 * `${serverUserId}:${streamID}`, which is not a room the SFU has ever heard
 * of — the registered id is `${serverId}_${voiceChannelId}` (voice.ts, where
 * the room is created) — and the user was the *socket id* rather than the
 * server user id. So the call went out, matched nothing, and the only thing
 * actually silencing anyone was their own client choosing to honour the
 * `server:muted` event. A modified client simply kept talking.
 *
 * This mirrors the equivalent call in voice.ts on purpose: same room shape,
 * same user id, same effective-state OR.
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

/**
 * A colour a client is willing to render, or null.
 *
 * `#rrggbb` only. The value goes straight into a style on every client that
 * shows the role, so anything that is not obviously a colour is dropped rather
 * than passed through and hoped about.
 */
/**
 * One half of an automatic-grant condition, as it arrives from a client.
 *
 * `undefined` means "leave it alone" and is passed straight through; anything
 * that is not a positive number becomes null, which is off. A cap because
 * these are two number fields on a form and there is no reading of "grant this
 * after nine hundred million messages" worth storing.
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
 * Everything the role editor needs, in one payload.
 *
 * The permission catalogue rides along rather than being written down in the
 * client. A client built against an older server would otherwise show a
 * permission list missing whatever the server has since added, with no sign
 * that anything was missing — and the editor saves the whole set, so the
 * missing ones would be dropped on the next save.
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
  };
}

/**
 * The bots an operator can see, without the one thing they must not see twice.
 *
 * `claim_token` is deliberately absent. It is shown once, in the reply to
 * `server:bots:register`, and never again — a token that can be re-read from a
 * list is a token that lives as long as the list does.
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
   *
   * Three events do the same five checks — replace, add, remove — and the
   * failure mode of writing them three times is one of them being one check
   * short, which is a privilege escalation rather than a cosmetic difference.
   * Each error is emitted here so the wording stays the same too.
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

        // This event asks only that you have joined, so every member receives
        // it — and `systemChannelId` is a channel id. If the system channel is
        // one somebody cannot see, naming it here undoes the rest of the work.
        // Blanked rather than the whole payload refused: the other twenty
        // settings are theirs to read, and a client that cannot resolve the id
        // draws nothing, which is what it should draw.
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

    'server:invites:create': async (payload: { accessToken: string; infinite?: boolean; maxUses?: number; expiresInHours?: number; note?: string | null; customCode?: string | null }) => {
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
    // Only meaningful while join_policy is "request", but readable whatever it
    // is: switching away from request should not hide a queue somebody is still
    // owed a decision on.

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

    /*
     * Replace everything somebody holds with this one role.
     *
     * What a demotion means, and what every client sent before more than one
     * role was representable. `server:roles:add` below is the other half.
     */
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
     * Give somebody a role without taking away the ones they have.
     *
     * `server:roles:set` replaces the set, which is what a demotion means and
     * what every client sent before more than one role was representable. This
     * is the other half: a moderator who is also a contributor is two grants,
     * not a third role invented to mean both.
     *
     * Same gates as set, and for the same reasons — an operator who can add a
     * role they do not outrank can promote themselves one step removed.
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
     * Take one role away, leaving the rest.
     *
     * Removing the last one is allowed. It leaves them on the joiner default
     * for their identity tier, which is where somebody who has never been given
     * a role sits — not on nothing.
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

    /**
     * Create a role, or edit one that exists.
     *
     * One event for both because the editor does not know which it is doing:
     * the same form saves a role that was created three seconds ago and one
     * that has been there since the server was set up.
     */
    'server:roles:definitions:save': async (payload: {
      accessToken: string;
      roleId: string;
      name?: string;
      color?: string | null;
      rank?: number;
      permissions?: string[];
      autoGrantAfterDays?: number | null;
      autoGrantAfterMessages?: number | null;
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

        // The owner role is what the fail-open path in services/permissions
        // falls back to, and it is the only thing standing between a mistake in
        // this editor and a server nobody can administer. It is readable and
        // not editable.
        if (roleId === OWNER_ROLE_ID) {
          socket.emit("server:error", { error: "forbidden", message: "The owner role cannot be edited." });
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

        const saved = existing
          ? await updateRoleDefinition(roleId, {
              name,
              color,
              rank,
              permissions,
              autoGrantAfterDays,
              autoGrantAfterMessages,
            })
          : await createRoleDefinition(roleId, {
              name,
              color,
              rank,
              permissions,
              autoGrantAfterDays,
              autoGrantAfterMessages,
            });

        insertServerAudit({
          actorServerUserId: auth.tokenPayload.serverUserId,
          action: existing ? "role_definition_update" : "role_definition_create",
          target: roleId,
          meta: { name, rank, permissions, autoGrantAfterDays, autoGrantAfterMessages },
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

    /**
     * Which role people land on when they join, per identity tier.
     *
     * The setting that makes a public server possible: accounts get one role,
     * keys-with-no-account get another, and neither has to be handed out by a
     * moderator watching the door.
     */
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
     * Answer a bot that knocked.
     *
     * `permissions` is what the operator ticked, and the registry intersects it
     * with what the bot asked for — an operator cannot grant something that was
     * never requested, which is what stops "approve" from being a blank cheque
     * on a screen somebody is clicking through quickly.
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
     * Write down what a bot may do before there is a bot.
     *
     * The unattended path: the operator decides everything up front and hands
     * the token to whoever is deploying it. The token is shown once, here.
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
     * Withdraw a bot's registration.
     *
     * Takes effect at the next thing it tries, because standing is resolved
     * from the registry on every check — there is no cached grant to expire.
     * The membership row is left alone; removing that is a kick or a ban, and
     * revoking permission has to work whether or not it is connected.
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
     * How a member got in, for the moderator about to remove them.
     *
     * Admin-gated and asked for by id rather than broadcast, because the
     * member list goes to everybody and an invite code in it would be a way
     * for any member to collect working codes.
     *
     * The answer is what makes GRYT-177's question worth asking: banning
     * somebody who arrived on a still-live invite achieves little on its own,
     * since an identity with no account costs nothing to replace.
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

        // Erase what they wrote, if asked. Defaults to on, because a ban is
        // usually about the content as much as the person — but it is a choice,
        // since unban can restore access and cannot restore a thread. Replies
        // to a deleted message lose their context for everybody, not just for
        // the person banned.
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
          // No per-message broadcast for the reactions they left on other
          // people's messages. The client already holds those messages and can
          // strip the id itself from the purge event — emitting one
          // chat:reaction each would mean hundreds of broadcasts for a
          // prolific reactor, to say something the client can work out.
          consola.info(
            `Purged ${deletedMessages.length} messages, ${updatedReactions.length} reactions and ${files.deleted} file(s) for ${targetId}`,
          );
        }

        // Close the door they came through, if asked.
        //
        // A ban is keyed on the identity, and an identity with no account
        // behind it costs nothing to replace — so somebody banned can come
        // straight back on a new key, presenting the same invite they used the
        // first time. Verified against a live server: it takes seconds.
        //
        // This does not make the ban durable, nothing can. It closes the one
        // case where a moderator's decision is undone by a link they had
        // forgotten was still live.
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

        // `view_audit_log` is its own permission and interfaces.ts describes
        // exactly the case that makes this a leak: "a rank-90 auditor with
        // nothing but view_audit_log". Rank does not gate the audit log, so an
        // auditor below a channel's scope would otherwise read that channel's
        // id out of `target` — and its name out of `meta`, which channel_upsert
        // records. Entries about a channel they cannot see are dropped whole
        // rather than redacted, because a redacted row still says one exists.
        // mayViewChannel answers true for anything that is not a channel, which
        // is most targets here — user ids, role ids, webhook ids. So this asks
        // one question per row and only narrows the channel ones. It reads a
        // cache rather than the database, so the per-row call is cheap.
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
