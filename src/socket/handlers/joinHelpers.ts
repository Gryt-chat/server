import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { pluginEvents } from "../../plugins";
import { syncAllClients, broadcastMemberList, verifyClient } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import { postSystemMessage, formatLeaveMessage } from "../utils/systemMessages";
import { generateAccessToken, generateFileToken, verifyAccessToken } from "../../utils/jwt";
import {
  getServerConfig,
  getUserByServerId,
  setUserAvatar,
  setUserInactive,
  purgeOrphanedConversations,
  getRefreshToken,
  revokeUserRefreshTokens,
  effectiveModerationState,
} from "../../db";
import { checkSessionAllowed } from "../../moderation/sessionGate";

// ── Password cooldown ──────────────────────────────────────────────
//
// Two-tier brute-force protection:
//   1. Per (IP + user) — prevents targeted attacks against a single account.
//   2. Per IP only     — catches attackers cycling through accounts from one IP.
//
// Cooldowns escalate exponentially on repeated lockouts:
//   base × 2^(lockouts-1), capped at SERVER_INVITE_MAX_COOLDOWN_MS.
//   e.g. 1 min → 2 min → 4 min → … → 1 hour (default cap).

type CooldownState = {
  count: number;
  lockouts: number;
  windowStartMs: number;
  cooldownUntilMs: number;
};

const INVITE_MAX_RETRIES = Math.max(1, Math.min(50, parseInt(process.env.SERVER_INVITE_MAX_RETRIES || "8", 10) || 8));
const INVITE_RETRY_WINDOW_MS = Math.max(10_000, Math.min(60 * 60_000, parseInt(process.env.SERVER_INVITE_RETRY_WINDOW_MS || "300000", 10) || 300_000));
const INVITE_BASE_COOLDOWN_MS = Math.max(1_000, Math.min(24 * 60 * 60_000, parseInt(process.env.SERVER_INVITE_RETRY_COOLDOWN_MS || "60000", 10) || 60_000));
const INVITE_MAX_COOLDOWN_MS = Math.max(INVITE_BASE_COOLDOWN_MS, Math.min(24 * 60 * 60_000, parseInt(process.env.SERVER_INVITE_MAX_COOLDOWN_MS || "3600000", 10) || 3_600_000));
const IP_INVITE_MAX_RETRIES = Math.max(1, Math.min(200, parseInt(process.env.SERVER_INVITE_IP_MAX_RETRIES || "20", 10) || 20));

const perKeyCooldowns = new Map<string, CooldownState>();
const perIpCooldowns = new Map<string, CooldownState>();

setInterval(() => {
  const now = Date.now();
  const staleAfter = INVITE_RETRY_WINDOW_MS + INVITE_MAX_COOLDOWN_MS;
  for (const [key, s] of perKeyCooldowns) {
    if (now - s.windowStartMs > staleAfter && now > (s.cooldownUntilMs || 0)) perKeyCooldowns.delete(key);
  }
  for (const [key, s] of perIpCooldowns) {
    if (now - s.windowStartMs > staleAfter && now > (s.cooldownUntilMs || 0)) perIpCooldowns.delete(key);
  }
}, 10 * 60_000).unref();

function computeCooldownMs(lockouts: number): number {
  return Math.min(INVITE_MAX_COOLDOWN_MS, INVITE_BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, lockouts - 1)));
}

function getState(map: Map<string, CooldownState>, key: string, now = Date.now()): CooldownState {
  const existing = map.get(key);
  if (!existing) {
    const s: CooldownState = { count: 0, lockouts: 0, windowStartMs: now, cooldownUntilMs: 0 };
    map.set(key, s);
    return s;
  }
  if (now - existing.windowStartMs > INVITE_RETRY_WINDOW_MS) {
    existing.count = 0;
    existing.windowStartMs = now;
  }
  if (existing.count === 0 && existing.cooldownUntilMs > 0 && now > existing.cooldownUntilMs + INVITE_RETRY_WINDOW_MS) {
    map.delete(key);
    const s: CooldownState = { count: 0, lockouts: 0, windowStartMs: now, cooldownUntilMs: 0 };
    map.set(key, s);
    return s;
  }
  return existing;
}

function applyFailure(map: Map<string, CooldownState>, key: string, maxRetries: number, now = Date.now()): { locked: boolean; retryAfterMs: number } {
  const s = getState(map, key, now);
  if (s.cooldownUntilMs && now < s.cooldownUntilMs) {
    return { locked: true, retryAfterMs: Math.max(0, s.cooldownUntilMs - now) };
  }
  s.count += 1;
  if (s.count >= maxRetries) {
    s.lockouts += 1;
    s.count = 0;
    s.windowStartMs = now;
    const cooldown = computeCooldownMs(s.lockouts);
    s.cooldownUntilMs = now + cooldown;
    return { locked: true, retryAfterMs: cooldown };
  }
  return { locked: false, retryAfterMs: 0 };
}

// ── Per (IP + user) ──────────────────────────────────────────────────

export function getInviteCooldownKey(ip: string, grytUserId: string): string {
  return `${ip}::${grytUserId}`;
}

export function getInviteCooldownState(key: string, now = Date.now()): CooldownState {
  return getState(perKeyCooldowns, key, now);
}

export function clearInviteCooldown(key: string): void {
  perKeyCooldowns.delete(key);
}

export function applyInviteFailure(key: string, now = Date.now()): { locked: boolean; retryAfterMs: number } {
  return applyFailure(perKeyCooldowns, key, INVITE_MAX_RETRIES, now);
}

// ── Per IP ───────────────────────────────────────────────────────────

export function getInviteIpCooldownState(ip: string, now = Date.now()): CooldownState {
  return getState(perIpCooldowns, ip, now);
}

export function clearInviteIpCooldown(ip: string): void {
  perIpCooldowns.delete(ip);
}

export function applyInviteIpFailure(ip: string, now = Date.now()): { locked: boolean; retryAfterMs: number } {
  return applyFailure(perIpCooldowns, ip, IP_INVITE_MAX_RETRIES, now);
}

// ── Handlers ─────────────────────────────────────────────────────────

export function registerJoinHelpers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient } = ctx;

  return {
    'server:leave': async () => {
      try {
        const clientInfo = clientsInfo[clientId];
        if (!clientInfo || !clientInfo.serverUserId || clientInfo.serverUserId.startsWith("temp_")) {
          socket.emit("server:error", {
            error: "not_registered",
            message: "You are not a registered member of this server.",
          });
          return;
        }

        const { nickname, serverUserId } = clientInfo;

        // The owner cannot leave. There is exactly one -- ownership is
        // `server_config.owner_gryt_user_id`, not a role somebody else can also
        // hold -- so leaving would put the server beyond anybody's reach, with
        // no settings, no moderation and no way to hand it over. Nothing
        // stopped this before, because until now the client's Leave button
        // never reached this handler at all.
        const config = await getServerConfig();
        if (clientInfo.grytUserId && config?.owner_gryt_user_id === clientInfo.grytUserId) {
          socket.emit("server:error", {
            error: "owner_cannot_leave",
            message:
              "You own this server, so leaving it would leave nobody able to " +
              "administer it. Hand ownership to somebody else first, or remove " +
              "it from your sidebar instead.",
          });
          return;
        }

        await setUserInactive(serverUserId);

        // The picture goes, the row stays. Nothing points at the file once the
        // column is cleared, so the media sweep collects it; what is kept is
        // the nickname and the membership row, which is what the messages they
        // wrote are attributed to. Rejoining rebinds to that same row and
        // uploads a new picture, so this costs a re-upload and nothing else.
        await setUserAvatar(serverUserId, null).catch((e) =>
          consola.warn("clearing the avatar on leave failed", e),
        );

        // Plugins hear about it (GRYT-933). Emitted here rather than on a
        // socket disconnect, which happens every time somebody closes a laptop
        // lid and is not leaving.
        pluginEvents().emit("member:left", {
          userId: serverUserId,
          nickname: nickname ?? null,
          reason: "left",
          at: new Date().toISOString(),
        });

        // A conversation nobody here can open again is one this server is
        // holding on behalf of two people who have both gone. Swept on the way
        // out rather than on a timer, so the answer to "how long do you keep my
        // DMs" is "until you both leave" rather than a number.
        await purgeOrphanedConversations()
          .then((ids) => {
            if (ids.length > 0) consola.info(`Purged ${ids.length} orphaned conversation(s) after leave`);
          })
          .catch((e) => consola.warn("conversation purge failed", e));

        if (clientInfo.grytUserId) {
          await revokeUserRefreshTokens(clientInfo.grytUserId).catch((e) => consola.warn("token revocation failed", e));
        }

        if (clientInfo.hasJoinedChannel && sfuClient) {
          sfuClient.untrackUserConnection(serverUserId);
        }

        delete clientsInfo[clientId];
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
        postSystemMessage(io, clientsInfo, formatLeaveMessage(nickname, serverUserId));
        socket.emit("server:left", { message: "Successfully left the server" });
      } catch (err) {
        consola.error("server:leave failed", err);
        socket.emit("server:error", { error: "leave_failed", message: "Could not leave this server." });
      }
    },

    'server:details': () => {
      try {
        sendServerDetails(socket, clientsInfo, serverId);
      } catch (err) {
        consola.error("server:details failed", err);
        socket.emit("server:error", "Failed to get server details");
      }
    },

    'token:refresh': async (payload: {
      refreshToken?: string;
      accessToken?: string;
    }) => {
      try {
        if (payload?.refreshToken) {
          const record = await getRefreshToken(payload.refreshToken);
          if (!record || record.revoked) {
            socket.emit("token:error", { error: "refresh_token_invalid", message: "Refresh token is invalid or revoked. Please rejoin." });
            return;
          }
          if (record.expires_at && new Date(record.expires_at) < new Date()) {
            socket.emit("token:error", { error: "refresh_token_expired", message: "Refresh token expired. Please rejoin." });
            return;
          }

          const cfg = await getServerConfig();
          const currentVersion = cfg?.token_version ?? 0;

          const gate = await checkSessionAllowed({
            grytUserId: record.gryt_user_id,
            serverUserId: record.server_user_id,
          });
          if (!gate.ok) {
            socket.emit("token:error", { error: gate.code, message: gate.message });
            return;
          }
          const user = gate.user;

          const refreshedPayload = {
            grytUserId: record.gryt_user_id,
            serverUserId: record.server_user_id,
            nickname: user.nickname,
            serverHost: socket.handshake.headers.host || "unknown",
            tokenVersion: currentVersion,
            userTokenVersion: user.token_version ?? 0,
          };
          const newAccessToken = generateAccessToken(refreshedPayload);
          // Re-minted with the access token rather than on its own timer. A
          // file token outlives one by hours, so a session that keeps refreshing
          // never reaches the point where its pictures stop loading.
          const newFileToken = generateFileToken(refreshedPayload);

          if (clientsInfo[clientId]) {
            clientsInfo[clientId].accessToken = newAccessToken;
            clientsInfo[clientId].grytUserId = record.gryt_user_id;
            clientsInfo[clientId].serverUserId = record.server_user_id;
            clientsInfo[clientId].nickname = user.nickname;
            const moderation = effectiveModerationState(user);
            clientsInfo[clientId].isServerMuted = moderation.isServerMuted;
            clientsInfo[clientId].isServerDeafened = moderation.isServerDeafened;
          }
          await verifyClient(socket, clientsInfo);
          syncAllClients(io, clientsInfo);
          broadcastMemberList(io, clientsInfo, serverId);
          socket.emit("token:refreshed", { accessToken: newAccessToken, fileToken: newFileToken });
        } else if (payload?.accessToken) {
          const decoded = verifyAccessToken(payload.accessToken);
          if (!decoded) {
            socket.emit("token:error", "Invalid access token");
            return;
          }
          if (decoded.serverHost !== socket.handshake.headers.host) {
            socket.emit("token:error", "Invalid access token for this server");
            return;
          }

          const cfg = await getServerConfig();
          const currentVersion = cfg?.token_version ?? 0;
          if ((decoded.tokenVersion ?? 0) !== currentVersion) {
            socket.emit("token:revoked", { reason: "token_version_mismatch", message: "Session stale. Please rejoin." });
            return;
          }

          const { grytUserId, serverUserId, nickname, serverHost } = decoded;

          // This branch used to re-mint purely from the old token's claims,
          // touching the database not at all — so it renewed sessions for
          // banned users and for users who were no longer members.
          const gate = await checkSessionAllowed({ grytUserId, serverUserId });
          if (!gate.ok) {
            socket.emit("token:error", { error: gate.code, message: gate.message });
            return;
          }

          // The branch that made revocation not work. It re-mints from the
          // claims of a token the caller already holds, so a client that
          // refreshes before its fifteen minutes are up renews forever. The
          // refresh-token branch above checks `revoked`; this one never did,
          // so signing out of every device left a running client untouched.
          // Now a token minted before the member's token_version was bumped is
          // refused here too, and the new one carries the current value.
          if ((decoded.userTokenVersion ?? 0) !== (gate.user.token_version ?? 0)) {
            socket.emit("token:revoked", {
              reason: "user_token_version_mismatch",
              message: "Your session was ended. Please sign in again.",
            });
            return;
          }

          const renewed = {
            grytUserId,
            serverUserId,
            nickname,
            serverHost,
            tokenVersion: currentVersion,
            userTokenVersion: gate.user.token_version ?? 0,
          };
          const newToken = generateAccessToken(renewed);
          const newFileToken = generateFileToken(renewed);
          if (clientsInfo[clientId]) {
            clientsInfo[clientId].accessToken = newToken;
            clientsInfo[clientId].grytUserId = grytUserId;
            clientsInfo[clientId].serverUserId = serverUserId;
            clientsInfo[clientId].nickname = nickname;
          }
          await verifyClient(socket, clientsInfo);
          syncAllClients(io, clientsInfo);
          broadcastMemberList(io, clientsInfo, serverId);
          socket.emit("token:refreshed", { accessToken: newToken, fileToken: newFileToken });
        } else {
          socket.emit("token:error", "Invalid refresh payload");
        }
      } catch (err) {
        consola.error("token:refresh failed", err);
        socket.emit("token:error", "Failed to refresh token");
      }
    },
  };
}
