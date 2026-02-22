import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { syncAllClients, broadcastMemberList } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import { verifyIdentityToken } from "../../auth/oidc";
import { generateAccessToken, verifyAccessToken } from "../../utils/jwt";
import {
  getServerConfig,
  getUserByServerId,
  setUserInactive,
  getRefreshToken,
  revokeUserRefreshTokens,
} from "../../db/scylla";

// ── Password cooldown ──────────────────────────────────────────────
//
// Two-tier brute-force protection:
//   1. Per (IP + user) — prevents targeted attacks against a single account.
//   2. Per IP only     — catches attackers cycling through accounts from one IP.
//
// Cooldowns escalate exponentially on repeated lockouts:
//   base × 2^(lockouts-1), capped at PASSWORD_MAX_COOLDOWN_MS.
//   e.g. 1 min → 2 min → 4 min → … → 1 hour (default cap).

type CooldownState = {
  count: number;
  lockouts: number;
  windowStartMs: number;
  cooldownUntilMs: number;
};

const PASSWORD_MAX_RETRIES = Math.max(1, Math.min(50, parseInt(process.env.SERVER_PASSWORD_MAX_RETRIES || "5", 10) || 5));
const PASSWORD_RETRY_WINDOW_MS = Math.max(10_000, Math.min(60 * 60_000, parseInt(process.env.SERVER_PASSWORD_RETRY_WINDOW_MS || "300000", 10) || 300_000));
const PASSWORD_BASE_COOLDOWN_MS = Math.max(1_000, Math.min(24 * 60 * 60_000, parseInt(process.env.SERVER_PASSWORD_RETRY_COOLDOWN_MS || "60000", 10) || 60_000));
const PASSWORD_MAX_COOLDOWN_MS = Math.max(PASSWORD_BASE_COOLDOWN_MS, Math.min(24 * 60 * 60_000, parseInt(process.env.SERVER_PASSWORD_MAX_COOLDOWN_MS || "3600000", 10) || 3_600_000));
const IP_PASSWORD_MAX_RETRIES = Math.max(1, Math.min(200, parseInt(process.env.SERVER_PASSWORD_IP_MAX_RETRIES || "15", 10) || 15));

const perKeyCooldowns = new Map<string, CooldownState>();
const perIpCooldowns = new Map<string, CooldownState>();

setInterval(() => {
  const now = Date.now();
  const staleAfter = PASSWORD_RETRY_WINDOW_MS + PASSWORD_MAX_COOLDOWN_MS;
  for (const [key, s] of perKeyCooldowns) {
    if (now - s.windowStartMs > staleAfter && now > (s.cooldownUntilMs || 0)) perKeyCooldowns.delete(key);
  }
  for (const [key, s] of perIpCooldowns) {
    if (now - s.windowStartMs > staleAfter && now > (s.cooldownUntilMs || 0)) perIpCooldowns.delete(key);
  }
}, 10 * 60_000).unref();

function computeCooldownMs(lockouts: number): number {
  return Math.min(PASSWORD_MAX_COOLDOWN_MS, PASSWORD_BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, lockouts - 1)));
}

function getState(map: Map<string, CooldownState>, key: string, now = Date.now()): CooldownState {
  const existing = map.get(key);
  if (!existing) {
    const s: CooldownState = { count: 0, lockouts: 0, windowStartMs: now, cooldownUntilMs: 0 };
    map.set(key, s);
    return s;
  }
  if (now - existing.windowStartMs > PASSWORD_RETRY_WINDOW_MS) {
    existing.count = 0;
    existing.windowStartMs = now;
  }
  if (existing.count === 0 && existing.cooldownUntilMs > 0 && now > existing.cooldownUntilMs + PASSWORD_RETRY_WINDOW_MS) {
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

export function getPasswordCooldownKey(ip: string, grytUserId: string): string {
  return `${ip}::${grytUserId}`;
}

export function getPasswordCooldownState(key: string, now = Date.now()): CooldownState {
  return getState(perKeyCooldowns, key, now);
}

export function clearPasswordCooldown(key: string): void {
  perKeyCooldowns.delete(key);
}

export function applyPasswordFailure(key: string, now = Date.now()): { locked: boolean; retryAfterMs: number } {
  return applyFailure(perKeyCooldowns, key, PASSWORD_MAX_RETRIES, now);
}

// ── Per IP ───────────────────────────────────────────────────────────

export function getIpCooldownState(ip: string, now = Date.now()): CooldownState {
  return getState(perIpCooldowns, ip, now);
}

export function clearIpCooldown(ip: string): void {
  perIpCooldowns.delete(ip);
}

export function applyIpFailure(ip: string, now = Date.now()): { locked: boolean; retryAfterMs: number } {
  return applyFailure(perIpCooldowns, ip, IP_PASSWORD_MAX_RETRIES, now);
}

// ── Handlers ─────────────────────────────────────────────────────────

export function registerJoinHelpers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient } = ctx;

  return {
    'server:leave': async () => {
      try {
        const clientInfo = clientsInfo[clientId];
        if (!clientInfo || !clientInfo.serverUserId || clientInfo.serverUserId.startsWith("temp_")) {
          socket.emit("server:error", "You are not a registered user");
          return;
        }

        await setUserInactive(clientInfo.serverUserId);

        if (clientInfo.grytUserId) {
          await revokeUserRefreshTokens(clientInfo.grytUserId).catch(() => undefined);
        }

        if (clientInfo.hasJoinedChannel && sfuClient) {
          sfuClient.untrackUserConnection(clientInfo.serverUserId);
        }

        delete clientsInfo[clientId];
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
        socket.emit("server:left", { message: "Successfully left the server" });
      } catch (err) {
        consola.error("server:leave failed", err);
        socket.emit("server:error", "Failed to leave server");
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
      identityToken?: string;
      accessToken?: string;
    }) => {
      try {
        if (payload?.refreshToken && payload?.identityToken) {
          const record = await getRefreshToken(payload.refreshToken);
          if (!record || record.revoked) {
            socket.emit("token:error", { error: "refresh_token_invalid", message: "Refresh token is invalid or revoked. Please rejoin." });
            return;
          }
          if (record.expires_at && new Date(record.expires_at) < new Date()) {
            socket.emit("token:error", { error: "refresh_token_expired", message: "Refresh token expired. Please rejoin." });
            return;
          }

          let grytUserId: string;
          try {
            const verified = await verifyIdentityToken(payload.identityToken);
            grytUserId = verified.sub;
          } catch {
            socket.emit("token:error", { error: "identity_token_invalid", message: "Identity token invalid. Please sign in again." });
            return;
          }

          if (grytUserId !== record.gryt_user_id) {
            socket.emit("token:error", { error: "identity_mismatch", message: "Identity mismatch. Please rejoin." });
            return;
          }

          const cfg = await getServerConfig();
          const currentVersion = cfg?.token_version ?? 0;

          const user = await getUserByServerId(record.server_user_id);
          if (!user || !user.is_active) {
            socket.emit("token:error", { error: "membership_required", message: "You are no longer a member. Please rejoin." });
            return;
          }

          const newAccessToken = generateAccessToken({
            grytUserId: record.gryt_user_id,
            serverUserId: record.server_user_id,
            nickname: user.nickname,
            serverHost: socket.handshake.headers.host || "unknown",
            tokenVersion: currentVersion,
          });

          if (clientsInfo[clientId]) {
            clientsInfo[clientId].accessToken = newAccessToken;
          }
          socket.emit("token:refreshed", { accessToken: newAccessToken });
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
          const newToken = generateAccessToken({ grytUserId, serverUserId, nickname, serverHost, tokenVersion: currentVersion });
          if (clientsInfo[clientId]) clientsInfo[clientId].accessToken = newToken;
          socket.emit("token:refreshed", { accessToken: newToken });
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
