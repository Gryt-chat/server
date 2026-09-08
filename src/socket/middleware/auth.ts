import { Socket } from "socket.io";
import { verifyAccessToken, TokenPayload } from "../../utils/jwt";
import { getServerConfig } from "../../db";
import type { Permission } from "../../constants/permissions";
import { checkSessionAllowed } from "../../moderation/sessionGate";
import {
  getEffectiveStanding,
  getTargetRank,
  type EffectiveStanding,
} from "../../services/permissions";

/** A server defines its own roles, so a name here is only passed through to the
    client. */
export type Role = string;

export interface ServerConfig {
  owner_gryt_user_id?: string | null;
  token_version?: number;
  display_name?: string | null;
  description?: string | null;
  icon_url?: string | null;
  password_hash?: string | null;
  password_salt?: string | null;
  password_algo?: string | null;
  is_configured?: boolean;
}

export interface AuthResult {
  tokenPayload: TokenPayload;
  config: ServerConfig;
  role: Role;
  /** Rank, for the outranks checks. Higher acts on lower. */
  rank: number;
  permissions: ReadonlySet<Permission>;
  /** True when this is the server owner, whatever their roles row says. */
  isOwner: boolean;
}

/** Both sides through `services/permissions`, so there is one answer to who
    somebody is: `listMemberRoles` does not know about the config owner. */
function standingOf(
  tokenPayload: TokenPayload,
): Promise<EffectiveStanding> {
  return getEffectiveStanding(tokenPayload.serverUserId, tokenPayload.grytUserId);
}

/** One rule in one place, having been copied into four handlers and left out of
    two. Strictly greater, so one admin cannot kick another. */
export async function requireOutranks(
  socket: Socket,
  auth: AuthResult,
  targetServerUserId: string,
  action = "act on",
): Promise<boolean> {
  if (targetServerUserId === auth.tokenPayload.serverUserId) {
    socket.emit("server:error", {
      error: "forbidden",
      message: `Cannot ${action} yourself.`,
    });
    return false;
  }

  const targetRank = await getTargetRank(targetServerUserId);
  if (auth.rank <= targetRank) {
    socket.emit("server:error", {
      error: "forbidden",
      message: `Cannot ${action} a user with an equal or higher role.`,
    });
    return false;
  }

  return true;
}

/** Validates the token, checks both version counters and resolves the role.
    Null once it has emitted the refusal. */
export async function requireAuth(
  socket: Socket,
  payload: { accessToken?: string },
  options?: { permission?: Permission },
): Promise<AuthResult | null> {
  if (!payload || typeof payload.accessToken !== "string") {
    socket.emit("server:error", { error: "invalid_payload", message: "accessToken is required." });
    return null;
  }

  const tokenPayload = verifyAccessToken(payload.accessToken);
  if (!tokenPayload) {
    socket.emit("server:error", { error: "token_invalid", message: "Invalid access token." });
    return null;
  }

  if (tokenPayload.serverHost !== socket.handshake.headers.host) {
    socket.emit("server:error", { error: "token_invalid", message: "Invalid access token for this server." });
    return null;
  }

  const config = await getServerConfig();
  if (!config) {
    socket.emit("server:error", { error: "settings_failed", message: "Server is not initialized yet." });
    return null;
  }

  const currentVersion = config.token_version ?? 0;
  if ((tokenPayload.tokenVersion ?? 0) !== currentVersion) {
    socket.emit("token:revoked", {
      reason: "token_version_mismatch",
      message: "Your session token is stale. Please rejoin.",
    });
    return null;
  }

  // The admission points cover a socket becoming somebody; this covers one that
  // never restored a session and presents a valid token with each event.
  const gate = await checkSessionAllowed({
    grytUserId: tokenPayload.grytUserId,
    serverUserId: tokenPayload.serverUserId,
  });
  if (!gate.ok) {
    socket.emit("server:error", { error: gate.code, message: gate.message });
    return null;
  }

  // Per-member revocation off the row the gate loaded; the check above is the
  // server-wide counter. Same event, so a client needs no new handling.
  if ((tokenPayload.userTokenVersion ?? 0) !== (gate.user.token_version ?? 0)) {
    socket.emit("token:revoked", {
      reason: "user_token_version_mismatch",
      message: "Your session was ended. Please sign in again.",
    });
    return null;
  }

  const standing = await standingOf(tokenPayload);

  if (options?.permission && !standing.permissions.has(options.permission)) {
    socket.emit("server:error", {
      error: "forbidden",
      // Names the permission rather than a role, because with roles editable
      // "requires admin or higher" can be false on the very server saying it.
      message: `You do not have permission to do that (${options.permission}).`,
      permission: options.permission,
    });
    return null;
  }

  return {
    tokenPayload,
    config,
    role: standing.roleId,
    rank: standing.rank,
    permissions: standing.permissions,
    isOwner: standing.isOwner,
  };
}

/** For a handler needing a second check. Emits the same refusal `requireAuth`
    would, so a gate reached this way looks like one reached at the door. */
export function requirePermission(
  socket: Socket,
  auth: AuthResult,
  permission: Permission,
): boolean {
  if (auth.permissions.has(permission)) return true;
  socket.emit("server:error", {
    error: "forbidden",
    message: `You do not have permission to do that (${permission}).`,
    permission,
  });
  return false;
}
