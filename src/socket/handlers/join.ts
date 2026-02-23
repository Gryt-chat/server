import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { syncAllClients, broadcastMemberList, countOtherSessions } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import { verifyIdentityToken } from "../../auth/oidc";
import { generateAccessToken, TokenPayload } from "../../utils/jwt";
import {
  getServerConfig,
  createServerConfigIfNotExists,
  getUserByGrytId,
  upsertUser,
  consumeServerInvite,
  verifyServerPassword,
  getServerRole,
  setServerRole,
  createRefreshToken,
  isUserBanned,
} from "../../db/scylla";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import {
  registerJoinHelpers,
  getPasswordCooldownKey,
  getPasswordCooldownState,
  clearPasswordCooldown,
  applyPasswordFailure,
  getIpCooldownState,
  applyIpFailure,
} from "./joinHelpers";

// ── Rate limit rules ────────────────────────────────────────────────

const RL_JOIN: RateLimitRule = {
  limit: 20, windowMs: 60_000, banMs: 60_000,
  scorePerAction: 0.5, maxScore: 10, scoreDecayMs: 5000,
};

// ── Handlers ────────────────────────────────────────────────────────

export function registerJoinHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, getClientIp } = ctx;

  const helpers = registerJoinHelpers(ctx);

  return {
    ...helpers,

    'server:join': async (payload: {
      password?: string;
      nickname?: string;
      identityToken?: string;
      inviteCode?: string;
    }) => {
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("server:join", undefined, ip, RL_JOIN);
        if (!rl.allowed) {
          socket.emit("server:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        const authMode = (process.env.GRYT_AUTH_MODE || "required").toLowerCase();
        if (authMode === "disabled") {
          socket.emit("server:error", { error: "auth_disabled", message: "This server has disabled authentication." });
          return;
        }
        if (authMode !== "required") {
          socket.emit("server:error", { error: "auth_misconfigured", message: `Unsupported GRYT_AUTH_MODE "${authMode}".` });
          return;
        }

        if (!payload?.identityToken || typeof payload.identityToken !== "string") {
          socket.emit("server:error", {
            error: "auth_required",
            message: "Gryt authentication is required. Please sign in.",
            canReapply: true,
          });
          return;
        }

        let grytUserId: string;
        let suggestedNickname: string | undefined;
        let cfg = await getServerConfig().catch(() => null);

        try {
          const verified = await verifyIdentityToken(payload.identityToken);
          grytUserId = verified.sub;
          suggestedNickname = verified.preferredUsername || verified.email;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          consola.warn(`Identity token verification failed for ${clientId}`, message);
          socket.emit("server:error", {
            error: "identity_token_invalid",
            message: "Your sign-in token is invalid or expired. Please sign in again.",
            canReapply: true,
          });
          return;
        }

        const nickname = (payload.nickname || suggestedNickname || "User").trim();
        if (nickname.length > 50) {
          socket.emit("server:error", { error: "invalid_nickname", message: "Nickname too long (max 50)." });
          return;
        }

        const banned = await isUserBanned(grytUserId);
        if (banned) {
          socket.emit("server:error", { error: "banned", message: "You are banned from this server." });
          return;
        }

        // Existing active members skip password
        const existingMember = await getUserByGrytId(grytUserId);
        const isActiveMember = !!(existingMember && existingMember.is_active);

        if (!isActiveMember) {
          const ip = getClientIp();
          const pwKey = getPasswordCooldownKey(ip, grytUserId);
          const now = Date.now();
          const pwState = getPasswordCooldownState(pwKey, now);
          const ipState = getIpCooldownState(ip, now);
          const pwLocked = !!(pwState.cooldownUntilMs && now < pwState.cooldownUntilMs);
          const ipLocked = !!(ipState.cooldownUntilMs && now < ipState.cooldownUntilMs);
          if (pwLocked || ipLocked) {
            const retryAfterMs = Math.max(
              pwLocked ? pwState.cooldownUntilMs - now : 0,
              ipLocked ? ipState.cooldownUntilMs - now : 0,
            );
            socket.emit("server:error", {
              error: "password_rate_limited",
              message: "Too many incorrect attempts. Please wait.",
              retryAfterMs: Math.max(0, retryAfterMs),
              canReapply: true,
            });
            return;
          }

          const inviteCode = typeof payload.inviteCode === "string" ? payload.inviteCode.trim() : "";
          let inviteAccepted = false;
          if (inviteCode) {
            const consumed = await consumeServerInvite(inviteCode);
            if (!consumed.ok) {
              const msg =
                consumed.reason === "expired" ? "That invite code has expired."
                  : consumed.reason === "revoked" ? "That invite code has been revoked."
                    : consumed.reason === "used_up" ? "No uses remaining."
                      : "Invalid invite code.";
              socket.emit("server:error", { error: "invalid_invite", message: msg, canReapply: true });
              return;
            }
            inviteAccepted = true;
            clearPasswordCooldown(pwKey);
          }

          const envPassword = (process.env.SERVER_PASSWORD || "").trim();
          const dbHasPassword = !!(cfg?.password_hash && cfg?.password_salt);

          if (!inviteAccepted && dbHasPassword) {
            const provided = typeof payload.password === "string" ? payload.password : "";
            if (!provided) {
              socket.emit("server:error", { error: "password_required", message: "Password required.", canReapply: true });
              return;
            }
            const ok = await verifyServerPassword(provided, cfg!.password_salt!, cfg!.password_hash!);
            if (!ok) {
              const lock = applyPasswordFailure(pwKey);
              const ipLock = applyIpFailure(ip);
              const isLocked = lock.locked || ipLock.locked;
              const retryAfterMs = Math.max(lock.retryAfterMs, ipLock.retryAfterMs);
              socket.emit("server:error", {
                error: isLocked ? "password_rate_limited" : "invalid_password",
                message: isLocked ? "Too many attempts. Please wait." : "Invalid password.",
                retryAfterMs: retryAfterMs || undefined,
                canReapply: true,
              });
              return;
            }
            clearPasswordCooldown(pwKey);
          } else if (!inviteAccepted && envPassword) {
            const provided = typeof payload.password === "string" ? payload.password : "";
            if (!provided) {
              socket.emit("server:error", { error: "password_required", message: "Password required.", canReapply: true });
              return;
            }
            if (provided !== envPassword) {
              const lock = applyPasswordFailure(pwKey);
              const ipLock = applyIpFailure(ip);
              const isLocked = lock.locked || ipLock.locked;
              const retryAfterMs = Math.max(lock.retryAfterMs, ipLock.retryAfterMs);
              socket.emit("server:error", {
                error: isLocked ? "password_rate_limited" : "invalid_password",
                message: isLocked ? "Too many attempts. Please wait." : "Invalid password.",
                retryAfterMs: retryAfterMs || undefined,
                canReapply: true,
              });
              return;
            }
            clearPasswordCooldown(pwKey);
          }
        }

        if (!cfg) {
          const created = await createServerConfigIfNotExists({
            displayName: process.env.SERVER_NAME || undefined,
            description: process.env.SERVER_DESCRIPTION || undefined,
          });
          cfg = created.config;
        }

        const user = await upsertUser(grytUserId, nickname.trim());
        const isOwner = (cfg?.owner_gryt_user_id || null) === grytUserId;
        const setupRequired = isOwner && !cfg?.is_configured;
        const tokenVersion = cfg?.token_version ?? 0;

        try {
          const existingRole = await getServerRole(user.server_user_id);
          if (!existingRole) await setServerRole(user.server_user_id, isOwner ? "owner" : "member");
          else if (isOwner && existingRole !== "owner") await setServerRole(user.server_user_id, "owner");
        } catch (e) {
          consola.warn("Failed to ensure role row:", e);
        }

        const tokenPayload: TokenPayload = {
          grytUserId: user.gryt_user_id,
          serverUserId: user.server_user_id,
          nickname: user.nickname,
          serverHost: socket.handshake.headers.host || "unknown",
          tokenVersion,
        };

        const accessToken = generateAccessToken(tokenPayload);

        const refreshTokenRecord = await createRefreshToken({
          grytUserId: user.gryt_user_id,
          serverUserId: user.server_user_id,
        });

        if (clientsInfo[clientId]) {
          clientsInfo[clientId].grytUserId = user.gryt_user_id;
          clientsInfo[clientId].serverUserId = user.server_user_id;
          clientsInfo[clientId].nickname = user.nickname;
          clientsInfo[clientId].accessToken = accessToken;
        }

        const otherCount = countOtherSessions(clientsInfo, clientId, user.gryt_user_id);
        if (otherCount > 0) {
          consola.info(`User ${user.nickname} now has ${otherCount + 1} concurrent sessions`);
        }

        socket.emit("server:joined", {
          accessToken,
          refreshToken: refreshTokenRecord.token_id,
          nickname: user.nickname,
          avatarFileId: user.avatar_file_id || null,
          isOwner,
          setupRequired,
        });

        if (setupRequired) {
          socket.emit("server:setup_required", {
            serverId,
            settings: {
              displayName: cfg?.display_name || process.env.SERVER_NAME || "Unknown Server",
              description: cfg?.description || process.env.SERVER_DESCRIPTION || "A Gryt server",
              iconUrl: cfg?.icon_url || null,
              hasPassword: !!(cfg?.password_hash && cfg?.password_salt) || !!(process.env.SERVER_PASSWORD?.trim()),
              isConfigured: !!cfg?.is_configured,
            },
          });
        }

        try {
          sendServerDetails(socket, clientsInfo, serverId);
        } catch (e) {
          consola.error("Failed to send server details after join:", e);
        }
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (err) {
        consola.error("server:join failed", err);
        socket.emit("server:error", { error: "join_failed", message: "Failed to join server." });
      }
    },
  };
}
