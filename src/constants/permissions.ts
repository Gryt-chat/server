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
  /**
   * See what has been said, live and in history.
   *
   * The floor. Everything else in this group assumes it, and a role without it
   * is somebody who is in the server and cannot see it — which is a real thing
   * to want for a quarantine tier, and is why reading is a permission rather
   * than the absence of one.
   */
  "read_messages",
  "send_messages",
  /**
   * Open a direct message with another member, and post in one.
   *
   * Separate from `send_messages` because the two are genuinely different
   * things to want. A server running a public event wants open channels and
   * no DMs between strangers; a quiet server wants the opposite of neither.
   * `allow_dms` on `server_config` is the whole-server switch, and this is
   * the per-role one — a server with DMs off has them off for everybody,
   * whatever any role says.
   *
   * Reading an existing conversation is not gated on this. Losing the
   * permission stops you starting or continuing one; it does not reach back
   * and hide what was already said, the same way turning `allow_dms` off
   * does not.
   */
  "send_direct_messages",
  /** Edit a message you sent. Somebody else's is `manage_messages`. */
  "edit_own_messages",
  /** Delete a message you sent. Somebody else's is `manage_messages`. */
  "delete_own_messages",
  "attach_files",
  "add_reactions",
  /** Put a message in front of the moderators. */
  "report_messages",
  /**
   * Have links in the channel unfurled into a preview.
   *
   * Reader-side, not sender-side: the preview is fetched by the client that is
   * displaying the message, through this server. Turning it off for a role
   * stops that role's clients asking, which is the only place the server has
   * any say.
   */
  "use_link_previews",

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

  // ── Self and other members ────────────────────────────────────────
  "change_nickname",
  "change_avatar",
  /** See who else is here. */
  "view_members",
  /** Mint an invite code. */
  "create_invite",
  /** See every invite this server has issued, and revoke them. */
  "manage_invites",

  // ── Moderation ────────────────────────────────────────────────────
  /** Delete or edit somebody else's message. Your own never needs it. */
  "manage_messages",
  "kick_members",
  "ban_members",
  /** Read the ban list without being able to add to it. */
  "view_bans",
  /** Server mute, and time somebody out. */
  "mute_members",
  /** Server deafen. Separate because it decides what somebody may *hear*. */
  "deafen_members",
  /** Pull somebody out of a voice channel. */
  "disconnect_members",
  /** Read the reported-messages queue. */
  "view_reports",
  /** Act on what is in it. */
  "manage_reports",
  "manage_join_requests",

  // ── Administration ────────────────────────────────────────────────
  "manage_channels",
  /** The sidebar's layout: separators, spacers, and what order things are in. */
  "manage_sidebar",
  "manage_emojis",
  "manage_webhooks",
  /** Edit role definitions, and assign roles to members. */
  "manage_roles",
  /**
   * Answer a bot at the door, and decide what it may do.
   *
   * Separate from `manage_roles` because it is a different question. A role is
   * given to somebody who is already here; approving a bot is deciding whether
   * a piece of software joins at all, and the two are not obviously the same
   * person's job on a large server.
   */
  "manage_bots",
  /** Server name, description, icon, limits, join policy, the lot. */
  "manage_server",
  /**
   * Hand an existing membership to a different identity.
   *
   * Its own permission rather than part of `manage_server`, because it is the
   * one action here that makes somebody else's account into somebody else's
   * account. Owner-only by default.
   */
  "replace_identity",
  "view_audit_log",
  /** Whether this server is running a current build. */
  "view_server_status",
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

/**
 * What anybody who has been let in can do, whatever else their role says.
 *
 * Not enforced as a floor — a role really can have none of these, and then its
 * holders are in the server and cannot see it. It is the set every role gets on
 * *upgrade*, because before these permissions existed there was no gate on any
 * of them: reading, seeing who is here, reporting a message and unfurling a
 * link were open to every member, guests included. See PERMISSION_BACKFILLS.
 */
const OPEN_TO_EVERYONE = [
  "read_messages",
  "view_members",
  "report_messages",
  "use_link_previews",
] as const satisfies readonly Permission[];

/**
 * The read-only tier.
 *
 * Seeded with the four above rather than with nothing, which is what it held
 * when reading was not yet a permission. "Read-only" has to include reading.
 */
const GUEST_PERMISSIONS = OPEN_TO_EVERYONE;

/** What a plain member could do before permissions existed. */
const MEMBER_PERMISSIONS = [
  ...OPEN_TO_EVERYONE,
  "send_messages",
  "send_direct_messages",
  "edit_own_messages",
  "delete_own_messages",
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
 * Everything a member has, plus what the old `mod` gates allowed.
 *
 * Shorter than it looks like it should be, and deliberately so. `mod` gated
 * exactly `server:kick`, `server:mute` and `server:deafen`; bans, reports, join
 * requests and the audit log were all `admin`. Handing moderators the rest
 * because the name suggests it would be this change quietly widening what a
 * role can do, which is the one thing it must not do — an operator who wants
 * that ticks two boxes.
 *
 * `disconnect_members` is here because `voice:disconnect:user` was a `mod`
 * gate too, under the same permission mute used to carry.
 */
const MOD_PERMISSIONS = [
  ...MEMBER_PERMISSIONS,
  "kick_members",
  "mute_members",
  "deafen_members",
  "disconnect_members",
] as const satisfies readonly Permission[];

/**
 * Everything except the three that were owner-only.
 *
 * `manage_roles` and `manage_server` stay owner-only: an admin who could grant
 * `manage_roles` could grant themselves everything, which makes the owner's
 * authority advisory. `replace_identity` joins them because it sat inside
 * `manage_server` and handing somebody else's membership to a new key is not a
 * thing to acquire by upgrade. An owner who wants any of it ticks the box.
 */
const ADMIN_PERMISSIONS = EVERY_PERMISSION.filter(
  (p) =>
    p !== "manage_roles" &&
    p !== "manage_server" &&
    p !== "replace_identity" &&
    // Owner-only to begin with. Approving a bot is granting permissions to
    // something nobody in the room can vouch for, and it should start where the
    // other two grant-shaped powers already are.
    p !== "manage_bots",
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
  { id: "guest", name: "Guest", rank: 10, color: null, permissions: GUEST_PERMISSIONS },
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

// ── Upgrading an existing server ────────────────────────────────────

/**
 * Which permissions are new since a given schema version, and who should
 * already have them.
 *
 * The problem this solves: role rows store a list of permission strings, and a
 * build that adds a permission does not change any row. So on the release that
 * made reading a permission, every existing role — including the seeded
 * `member` — would have been a role that cannot read. The seeder cannot fix it
 * either, because it only inserts roles that are missing and must never
 * overwrite what an operator has chosen.
 *
 * So each new permission names the one it should follow. `everyone` means it
 * had no gate at all before, and therefore everybody had it. Anything else
 * means it was carved out of that permission, and whoever held the original
 * keeps doing what they were already doing.
 *
 * Grants only. Nothing here removes a permission from a role, so an operator's
 * choices survive an upgrade untouched.
 */
export interface PermissionBackfill {
  version: number;
  permission: Permission;
  /** The permission this was carved out of, or `everyone` for a new gate. */
  grantedWith: Permission | "everyone";
}

/**
 * Bump this when adding a batch, and give the new entries the new number.
 *
 * Version 1 is "roles carry permissions at all" (GRYT-444) — nothing to
 * backfill, the sets were written to match the old gates exactly. Version 2 is
 * this file's expansion (GRYT-453). Version 3 adds `manage_bots` (GRYT-460).
 */
export const PERMISSION_SCHEMA_VERSION = 4;

export const PERMISSION_BACKFILLS: readonly PermissionBackfill[] = [
  // Had no gate before: anybody admitted to the server could do all four.
  { version: 2, permission: "read_messages", grantedWith: "everyone" },
  { version: 2, permission: "view_members", grantedWith: "everyone" },
  { version: 2, permission: "report_messages", grantedWith: "everyone" },
  { version: 2, permission: "use_link_previews", grantedWith: "everyone" },

  // Editing and deleting your own message needed nothing but the ability to
  // have sent one.
  { version: 2, permission: "edit_own_messages", grantedWith: "send_messages" },
  { version: 2, permission: "delete_own_messages", grantedWith: "send_messages" },

  // Carved out of permissions that were doing two jobs.
  { version: 2, permission: "deafen_members", grantedWith: "mute_members" },
  { version: 2, permission: "disconnect_members", grantedWith: "mute_members" },
  { version: 2, permission: "view_bans", grantedWith: "ban_members" },
  { version: 2, permission: "view_reports", grantedWith: "manage_reports" },
  { version: 2, permission: "manage_sidebar", grantedWith: "manage_channels" },
  { version: 2, permission: "replace_identity", grantedWith: "manage_server" },
  { version: 2, permission: "view_server_status", grantedWith: "view_audit_log" },

  // Version 3 (GRYT-460). Bots did not exist, so nobody had this — and it goes
  // to whoever holds `manage_server`, which by default is the owner alone.
  { version: 3, permission: "manage_bots", grantedWith: "manage_server" },

  // Direct messages arrived already gated on `send_messages`, so on the
  // release that split them out every role that could talk in a channel
  // could already DM. Granting it alongside keeps that true rather than
  // taking something away from roles an operator never edited.
  { version: 4, permission: "send_direct_messages", grantedWith: "send_messages" },
];

/**
 * The permissions a stored role should gain when moving between two versions.
 *
 * Pure, so the interesting part is testable without a database — which matters,
 * because getting this wrong is a silent privilege change in either direction.
 */
export function backfillFor(
  current: readonly string[],
  fromVersion: number,
  toVersion: number = PERMISSION_SCHEMA_VERSION,
): Permission[] {
  const held = new Set(current);
  const gained: Permission[] = [];

  for (const entry of PERMISSION_BACKFILLS) {
    if (entry.version <= fromVersion || entry.version > toVersion) continue;
    if (held.has(entry.permission)) continue;
    if (entry.grantedWith !== "everyone" && !held.has(entry.grantedWith)) continue;
    gained.push(entry.permission);
    // Added as we go, so a chain — B carved out of A, C carved out of B — lands
    // in one pass rather than needing the list in dependency order.
    held.add(entry.permission);
  }

  return gained;
}
