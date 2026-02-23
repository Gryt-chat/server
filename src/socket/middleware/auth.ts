import { Socket } from "socket.io";
import { verifyAccessToken, TokenPayload } from "../../utils/jwt";
import { getServerConfig, getServerRole } from "../../db/scylla";

export type Role = "owner" | "admin" | "mod" | "member";

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
}

async function getEffectiveRole(
  tokenPayload: TokenPayload,
  cfg: ServerConfig | null,
): Promise<Role> {
  if (
    cfg?.owner_gryt_user_id &&
    tokenPayload.grytUserId &&
    cfg.owner_gryt_user_id === tokenPayload.grytUserId
  ) {
    return "owner";
  }
  try {
    const r = await getServerRole(tokenPayload.serverUserId);
    return (r || "member") as Role;
  } catch {
    return "member";
  }
}

const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, mod: 2, member: 1 };

/**
 * Validates an access token from the event payload, checks token version,
 * resolves the user's role, and optionally enforces a minimum role.
 *
 * Returns the validated AuthResult or null (after emitting the appropriate
 * error to the socket).
 */
export async function requireAuth(
  socket: Socket,
  payload: { accessToken?: string },
  options?: { requiredRole?: Role },
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

  const role = await getEffectiveRole(tokenPayload, config);

  if (options?.requiredRole) {
    const needed = ROLE_RANK[options.requiredRole] ?? 0;
    const actual = ROLE_RANK[role] ?? 0;
    if (actual < needed) {
      socket.emit("server:error", {
        error: "forbidden",
        message: `Requires ${options.requiredRole} or higher.`,
      });
      return null;
    }
  }

  return { tokenPayload, config, role };
}
