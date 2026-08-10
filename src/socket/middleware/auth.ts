import { Socket } from "socket.io";
import { verifyAccessToken, TokenPayload } from "../../utils/jwt";
import { getServerConfig, getServerRole, getUserByServerId } from "../../db";

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

export const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, mod: 2, member: 1 };

/**
 * The effective role of somebody who is not the caller.
 *
 * The mirror of `getEffectiveRole`, for the target of a moderation action. Both
 * have to agree, and until now they did not: the handlers resolved *both* sides
 * with `getServerRole`, which reads the roles table and knows nothing about
 * `server_config.owner_gryt_user_id`. A config-owner whose roles row says
 * `admin` therefore passed `requireAuth`'s owner-or-admin gate and was then
 * refused by the handler's own check when acting on an admin — blocked from
 * moderating their own server. The same gap protects a stale `owner` roles row
 * on somebody who is not the owner.
 */
export async function getEffectiveRoleForServerUser(
  serverUserId: string,
): Promise<Role> {
  try {
    const [cfg, user] = await Promise.all([
      getServerConfig(),
      getUserByServerId(serverUserId),
    ]);
    if (
      cfg?.owner_gryt_user_id &&
      user?.gryt_user_id &&
      cfg.owner_gryt_user_id === user.gryt_user_id
    ) {
      return "owner";
    }
    const r = await getServerRole(serverUserId);
    return (r || "member") as Role;
  } catch {
    // Fail closed. An unknown target reads as owner, so the action is refused
    // rather than allowed on a database hiccup.
    return "owner";
  }
}

/**
 * Whether the actor outranks the target, emitting the refusal if not.
 *
 * One rule in one place. It was copied verbatim into kick, ban, mute and
 * deafen — and left out of `voice:disconnect:user` and the reports panel's
 * delete-all-and-ban entirely, which is how an admin could voice-kick the owner
 * and ban them through a different screen than the one that says no.
 *
 * Strictly greater, so equal ranks cannot act on each other: one admin cannot
 * kick another, and only the owner can act on an admin.
 */
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

  const targetRole = await getEffectiveRoleForServerUser(targetServerUserId);
  if ((ROLE_RANK[auth.role] ?? 0) <= (ROLE_RANK[targetRole] ?? 0)) {
    socket.emit("server:error", {
      error: "forbidden",
      message: `Cannot ${action} a user with an equal or higher role.`,
    });
    return false;
  }

  return true;
}

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
