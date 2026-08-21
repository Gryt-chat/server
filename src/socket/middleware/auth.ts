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

/**
 * A role id. Used to be the four names this file knew about; a server defines
 * its own now, so the name is only ever passed through to the client.
 */
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

/**
 * The caller's standing, and the target's, both resolved the same way.
 *
 * They used to be resolved differently: the handlers read *both* sides with
 * `getServerRole`, which knows nothing about `server_config.owner_gryt_user_id`.
 * A config-owner whose roles row said `admin` therefore passed the owner-or-admin
 * gate and was then refused by the handler's own check when acting on an admin —
 * blocked from moderating their own server. Both sides go through
 * `services/permissions` now, so there is one answer to "who is this".
 */
function standingOf(
  tokenPayload: TokenPayload,
): Promise<EffectiveStanding> {
  return getEffectiveStanding(tokenPayload.serverUserId, tokenPayload.grytUserId);
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

  // Not redundant with the admission points. Those cover the ways a socket
  // becomes somebody; this covers a socket that never restored a session at all
  // and simply presents a still-valid token with each event. Without it a
  // banned user keeps full access for the life of that token.
  const gate = await checkSessionAllowed({
    grytUserId: tokenPayload.grytUserId,
    serverUserId: tokenPayload.serverUserId,
  });
  if (!gate.ok) {
    socket.emit("server:error", { error: gate.code, message: gate.message });
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

/**
 * A permission check on an already-authenticated caller, for handlers that need
 * a second one.
 *
 * Emits the same refusal `requireAuth` would, so a gate reached this way is
 * indistinguishable from one reached at the door.
 */
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
