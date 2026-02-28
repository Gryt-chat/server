import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { syncAllClients, broadcastMemberList, countOtherSessions, verifyClient } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import { postSystemMessage, formatJoinMessage } from "../utils/systemMessages";
import { createChallenge, consumeChallenge, verifyCertificate, verifyAssertion } from "../../auth/identity";
import { generateAccessToken, TokenPayload } from "../../utils/jwt";
import {
  getServerConfig,
  createServerConfigIfNotExists,
  claimServerOwner,
  getUserByGrytId,
  upsertUser,
  consumeServerInvite,
  getServerRole,
  setServerRole,
  createRefreshToken,
  isUserBanned,
} from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import {
  registerJoinHelpers,
  applyInviteFailure,
  applyInviteIpFailure,
  clearInviteCooldown,
  clearInviteIpCooldown,
  getInviteCooldownKey,
  getInviteCooldownState,
  getInviteIpCooldownState,
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

    // Step 1: Client requests to join. Server validates basic pre-conditions
    // and responds with a cryptographic challenge.
    'server:join': async (payload: {
      nickname?: string;
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

        const nickname = (payload?.nickname || "User").trim();
        if (nickname.length > 50) {
          socket.emit("server:error", { error: "invalid_nickname", message: "Nickname too long (max 50)." });
          return;
        }

        const serverHost = socket.handshake.headers.host || "unknown";
        const inviteCode = typeof payload?.inviteCode === "string" ? payload.inviteCode.trim() : undefined;

        const challenge = createChallenge(socket.id, serverHost, nickname, inviteCode);
        socket.emit("server:challenge", challenge);
      } catch (err) {
        consola.error("server:join failed", err);
        socket.emit("server:error", { error: "join_failed", message: "Failed to initiate join." });
      }
    },

    // Step 2: Client responds to the challenge with a signed assertion
    // and an identity certificate. Server verifies both and completes the join.
    'server:verify': async (payload: {
      certificate?: string;
      assertion?: string;
    }) => {
      try {
        const challenge = consumeChallenge(socket.id);
        if (!challenge) {
          socket.emit("server:error", {
            error: "challenge_expired",
            message: "Challenge expired or not found. Please try joining again.",
            canReapply: true,
          });
          return;
        }

        if (!payload?.certificate || typeof payload.certificate !== "string") {
          socket.emit("server:error", {
            error: "auth_required",
            message: "Identity certificate is required. Please sign in.",
            canReapply: true,
          });
          return;
        }

        if (!payload?.assertion || typeof payload.assertion !== "string") {
          socket.emit("server:error", {
            error: "auth_required",
            message: "Signed assertion is required.",
            canReapply: true,
          });
          return;
        }

        let grytUserId: string;
        let suggestedNickname: string | undefined;

        try {
          const cert = await verifyCertificate(payload.certificate);
          const assertionResult = await verifyAssertion(
            payload.assertion,
            cert.jwk,
            challenge.serverHost,
            challenge.nonce,
          );

          if (assertionResult.sub !== cert.sub) {
            throw new Error("Assertion subject does not match certificate subject");
          }

          grytUserId = cert.sub;
          suggestedNickname = cert.preferredUsername;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          consola.warn(`Identity verification failed for ${clientId}:`, message);
          socket.emit("server:error", {
            error: "identity_verification_failed",
            message: "Identity verification failed. Please sign in again.",
            canReapply: true,
          });
          return;
        }

        const nickname = (challenge.nickname || suggestedNickname || "User").trim();
        let cfg = await getServerConfig().catch(() => null);

        const banned = await isUserBanned(grytUserId);
        if (banned) {
          socket.emit("server:error", { error: "banned", message: "You are banned from this server." });
          return;
        }

        const existingMember = await getUserByGrytId(grytUserId);
        const isActiveMember = !!(existingMember && existingMember.is_active);
        let claimedOwnerGrytUserId: string | null | undefined;
        let usedInviteCode: string | undefined;

        if (!isActiveMember) {
          const ip = getClientIp();
          const inviteKey = getInviteCooldownKey(ip, grytUserId);
          const now = Date.now();
          const inviteState = getInviteCooldownState(inviteKey, now);
          const ipState = getInviteIpCooldownState(ip, now);
          const inviteLocked = !!(inviteState.cooldownUntilMs && now < inviteState.cooldownUntilMs);
          const ipLocked = !!(ipState.cooldownUntilMs && now < ipState.cooldownUntilMs);
          if (inviteLocked || ipLocked) {
            const retryAfterMs = Math.max(
              inviteLocked ? inviteState.cooldownUntilMs - now : 0,
              ipLocked ? ipState.cooldownUntilMs - now : 0,
            );
            socket.emit("server:error", {
              error: "invite_rate_limited",
              message: "Too many incorrect invite attempts. Please wait.",
              retryAfterMs: Math.max(0, retryAfterMs),
              canReapply: true,
            });
            return;
          }

          const inviteCode = challenge.inviteCode || "";
          if (inviteCode) {
            const consumed = await consumeServerInvite(inviteCode);
            if (!consumed.ok) {
              const msg =
                consumed.reason === "expired" ? "That invite code has expired."
                  : consumed.reason === "revoked" ? "That invite code has been revoked."
                    : consumed.reason === "used_up" ? "No uses remaining."
                      : "Invalid invite code.";
              const lock = applyInviteFailure(inviteKey);
              const ipLock = applyInviteIpFailure(ip);
              const isLocked = lock.locked || ipLock.locked;
              const retryAfterMs = Math.max(lock.retryAfterMs, ipLock.retryAfterMs);
              socket.emit("server:error", {
                error: isLocked ? "invite_rate_limited" : "invalid_invite",
                message: isLocked ? "Too many incorrect invite attempts. Please wait." : msg,
                retryAfterMs: isLocked ? (retryAfterMs || undefined) : undefined,
                canReapply: true,
              });
              return;
            }
            usedInviteCode = inviteCode;
            clearInviteCooldown(inviteKey);
            clearInviteIpCooldown(ip);
          } else {
            const claimed = await claimServerOwner(grytUserId);
            claimedOwnerGrytUserId = claimed.owner;
            if (claimedOwnerGrytUserId !== grytUserId) {
              socket.emit("server:error", {
                error: "invite_required",
                message: "Invite required to join this server.",
                canReapply: true,
              });
              return;
            }
            clearInviteCooldown(inviteKey);
            clearInviteIpCooldown(ip);
          }
        }

        if (!cfg) {
          const created = await createServerConfigIfNotExists({
            displayName: process.env.SERVER_NAME || undefined,
            description: process.env.SERVER_DESCRIPTION || undefined,
          });
          cfg = created.config;
        }

        const user = await upsertUser(grytUserId, nickname.trim(), {
          inviteCode: usedInviteCode,
        });
        const isOwner = ((claimedOwnerGrytUserId ?? cfg?.owner_gryt_user_id) || null) === grytUserId;
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

        verifyClient(socket);

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
        if (!isActiveMember) {
          postSystemMessage(io, clientsInfo, formatJoinMessage(user.nickname, user.server_user_id));
        }
      } catch (err) {
        consola.error("server:verify failed", err);
        socket.emit("server:error", { error: "join_failed", message: "Failed to join server." });
      }
    },
  };
}
