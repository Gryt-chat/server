/**
 * What a member of this server is allowed to do.
 *
 * Roles used to be a ladder of four names — owner, admin, mod, member — and
 * every gate in the codebase asked where on that ladder somebody stood. That
 * works right up until a server wants a tier that is *not* on the ladder: a
 * guest who may read and nothing else, a contributor who may talk but not
 * upload, a bot that may only react. None of those are "a bit less than mod".
 *
 * So a role now carries a set of these instead, and the gates ask for the one
 * thing they need. The ladder survives as `rank`, which is only about who may
 * act on whom — see `outranks` in the middleware. Capability and hierarchy are
 * genuinely different questions and conflating them is what made a guest tier
 * impossible to express.
 */
export const PERMISSIONS = [
  // ── Text ──────────────────────────────────────────────────────────
  "send_messages",
  "attach_files",
  "add_reactions",

  // ── Voice ─────────────────────────────────────────────────────────
  /** Enter a voice channel at all. Without it the channel is not joinable. */
  "join_voice",
  /**
   * Be unmuted once in. Somebody with `join_voice` and not this is in the room
   * and cannot be heard — which is a listener, and the reason the two are
   * separate permissions rather than one.
   */
  "speak",
  "share_video",
  "share_screen",

  // ── Self ──────────────────────────────────────────────────────────
  "change_nickname",
  "change_avatar",
  /** Mint an invite code. */
  "create_invite",
  /** See every invite this server has issued, and revoke them. */
  "manage_invites",

  // ── Moderation ────────────────────────────────────────────────────
  /** Delete or edit somebody else's message. Your own never needs it. */
  "manage_messages",
  "kick_members",
  "ban_members",
  /** Server mute, server deafen, timeouts, and pulling somebody out of voice. */
  "mute_members",
  "manage_reports",
  "manage_join_requests",

  // ── Administration ────────────────────────────────────────────────
  "manage_channels",
  "manage_emojis",
  "manage_webhooks",
  /** Edit role definitions, and assign roles to members. */
  "manage_roles",
  /** Server name, description, icon, limits, join policy, the lot. */
  "manage_server",
  "view_audit_log",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

/**
 * Keep only the permissions this build knows about.
 *
 * A role edited by a newer server, or a hand-edited row, can name something
 * that does not exist here. Dropping it is the fail-shut answer: an unknown
 * string can never satisfy a gate anyway, and keeping it around would mean the
 * editor shows a permission nobody can explain.
 */
export function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<Permission>();
  for (const entry of value) {
    if (isPermission(entry)) seen.add(entry);
  }
  return PERMISSIONS.filter((p) => seen.has(p));
}

// ── Built-in roles ──────────────────────────────────────────────────

/**
 * The roles every server starts with.
 *
 * `owner`, `admin`, `mod` and `member` are the four that already existed, with
 * the permission sets that reproduce what they could do before this file — so
 * an upgraded server behaves on Tuesday exactly as it did on Monday. `guest` is
 * new and empty: it is the read-only tier a public server hands to somebody who
 * arrived without an account, and it is seeded rather than left to be invented
 * because "read-only" is the one set an operator should not have to get right
 * by hand.
 *
 * Built-ins can be renamed, recoloured and re-permissioned like any other role.
 * What they cannot be is deleted, because the defaults and the owner fall back
 * to them — see `isSystemRole`.
 */
export interface BuiltInRole {
  id: string;
  name: string;
  rank: number;
  color: string | null;
  permissions: readonly Permission[];
}

const EVERY_PERMISSION = PERMISSIONS;

/** What a plain member could do before permissions existed. */
const MEMBER_PERMISSIONS = [
  "send_messages",
  "attach_files",
  "add_reactions",
  "join_voice",
  "speak",
  "share_video",
  "share_screen",
  "change_nickname",
  "change_avatar",
] as const satisfies readonly Permission[];

/**
 * Everything a member has, plus the two things the `mod` gates allowed.
 *
 * Shorter than it looks like it should be, and deliberately so. `mod` gated
 * exactly `server:kick`, `server:mute` and `server:deafen`; bans, reports, join
 * requests and the audit log were all `admin`. Handing moderators the rest
 * because the name suggests it would be this change quietly widening what a
 * role can do, which is the one thing it must not do — an operator who wants
 * that ticks two boxes.
 */
const MOD_PERMISSIONS = [
  ...MEMBER_PERMISSIONS,
  "kick_members",
  "mute_members",
] as const satisfies readonly Permission[];

/**
 * Everything except `manage_roles` and `manage_server`.
 *
 * Those two were owner-only, and they stay owner-only: an admin who could grant
 * `manage_roles` could grant themselves everything, which makes the owner's
 * authority advisory. An owner who wants that can tick the box; nobody gets it
 * by an upgrade.
 */
const ADMIN_PERMISSIONS = EVERY_PERMISSION.filter(
  (p) => p !== "manage_roles" && p !== "manage_server",
) as Permission[];

/**
 * Ranks are spaced so a custom role can be slotted between two built-ins
 * without renumbering anything.
 */
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  { id: "owner", name: "Owner", rank: 100, color: null, permissions: EVERY_PERMISSION },
  { id: "admin", name: "Admin", rank: 80, color: null, permissions: ADMIN_PERMISSIONS },
  { id: "mod", name: "Moderator", rank: 60, color: null, permissions: MOD_PERMISSIONS },
  { id: "member", name: "Member", rank: 40, color: null, permissions: MEMBER_PERMISSIONS },
  { id: "guest", name: "Guest", rank: 10, color: null, permissions: [] },
];

const SYSTEM_ROLE_IDS: ReadonlySet<string> = new Set(BUILT_IN_ROLES.map((r) => r.id));

export function isSystemRole(roleId: string): boolean {
  return SYSTEM_ROLE_IDS.has(roleId);
}

/** The role somebody falls back to when theirs was deleted or never existed. */
export const FALLBACK_ROLE_ID = "member";

/** The role that always holds every permission, whatever its row says. */
export const OWNER_ROLE_ID = "owner";

/**
 * A role id is chosen by whoever creates the role and ends up in a column that
 * other rows point at, so it is kept to the shape of a slug rather than
 * accepting anything. Lowercase because ids are compared exactly and a role
 * called `Trusted` that is sometimes `trusted` is two roles.
 */
export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidRoleId(value: unknown): value is string {
  return typeof value === "string" && ROLE_ID_PATTERN.test(value);
}
