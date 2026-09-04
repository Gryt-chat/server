/**
 * What a member of this server is allowed to do.
 *
 * A role carries a set of these and each gate asks for the one thing it needs.
 * `rank` is separate and is only about who may act on whom — see `outranks` in
 * the middleware. Capability and hierarchy are different questions.
 */
export const PERMISSIONS = [
  // ── Text ──────────────────────────────────────────────────────────
  /** See what has been said. A role without it is in the server and blind. */
  "read_messages",
  "send_messages",
  /**
   * Start or post in a DM. `allow_dms` on `server_config` is the whole-server
   * switch and wins over any role. Reading an existing conversation is not
   * gated on this — losing it does not hide what was already said.
   */
  "send_direct_messages",
  /** Edit a message you sent. Somebody else's is `manage_messages`. */
  "edit_own_messages",
  /** Delete a message you sent. Somebody else's is `manage_messages`. */
  "delete_own_messages",
  "attach_files",
  "add_reactions",
  /**
   * Report a message or a person, both. Channel-scoped for messages;
   * `user:report` asks for it at server scope.
   */
  "report_messages",
  /** Unfurl links. Reader-side: the displaying client fetches the preview. */
  "use_link_previews",

  // ── Voice ─────────────────────────────────────────────────────────
  /** Enter a voice channel at all. Without it the channel is not joinable. */
  "join_voice",
  /** Be unmuted once in. `join_voice` without this is a listener. */
  "speak",
  "share_video",
  "share_screen",
  /**
   * Start a call. Answering one is `join_voice`, deliberately — gating both
   * would leave somebody unable to pick up a call placed to them.
   */
  "start_calls",

  // ── Self and other members ────────────────────────────────────────
  "change_nickname",
  /** Choose an owl, or clear one. A string the client draws, not a file. */
  "change_avatar",
  /**
   * Upload a picture to use as one. Split from `change_avatar` because this
   * one puts a stranger's file in front of everybody. A member without it
   * still gets every owl.
   */
  "upload_avatar_image",
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
  /** Answer a bot at the door, and decide what it may do. */
  "manage_bots",
  /** Server name, description, icon, limits, join policy, the lot. */
  "manage_server",
  /**
   * Hand an existing membership to a different identity. Owner-only by
   * default: it is the one action that makes an account into another account.
   */
  "replace_identity",
  "view_audit_log",
  /** Whether this server is running a current build. */
  "view_server_status",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The permissions a single channel can have an opinion about — a deliberate
 * subset, since `ban_members` means the same thing wherever you stand.
 *
 * `read_messages` denied at channel scope does not grey the channel out: the
 * server stops naming it, so the member cannot learn it exists. See
 * services/channelPermissions.
 */
export const CHANNEL_PERMISSIONS = [
  "read_messages",
  "send_messages",
  "edit_own_messages",
  "delete_own_messages",
  "attach_files",
  "add_reactions",
  "report_messages",
  "use_link_previews",
  "manage_messages",
  "join_voice",
  "speak",
  "share_video",
  "share_screen",
] as const;

export type ChannelPermission = (typeof CHANNEL_PERMISSIONS)[number];

const CHANNEL_PERMISSION_SET: ReadonlySet<string> = new Set(CHANNEL_PERMISSIONS);

/** Whether this permission means anything when scoped to one channel. */
export function isChannelPermission(value: unknown): value is ChannelPermission {
  return typeof value === "string" && CHANNEL_PERMISSION_SET.has(value);
}

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

/**
 * Keep only the permissions this build knows about. A role edited by a newer
 * server can name one that does not exist here; dropping it fails shut.
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
 * The roles every server starts with. They can be renamed, recoloured and
 * re-permissioned like any other role, but not deleted — the defaults and the
 * owner fall back to them. See `isSystemRole`.
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
 * Not a floor — a role really can have none of these. It is the set every role
 * gets on *upgrade*, since none of them were gated before. See
 * PERMISSION_BACKFILLS.
 */
const OPEN_TO_EVERYONE = [
  "read_messages",
  "view_members",
  "report_messages",
  "use_link_previews",
] as const satisfies readonly Permission[];

/** The read-only tier. Seeded with the four above; read-only includes reading. */
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
  "start_calls",
  "change_nickname",
  "change_avatar",
  "upload_avatar_image",
] as const satisfies readonly Permission[];

/**
 * Deliberately shorter than the name suggests. `mod` gated exactly kick, mute
 * and deafen; bans, reports, join requests and the audit log were `admin`.
 * Adding the rest would widen what the role can do, which this must not.
 */
const MOD_PERMISSIONS = [
  ...MEMBER_PERMISSIONS,
  "kick_members",
  "mute_members",
  "deafen_members",
  "disconnect_members",
] as const satisfies readonly Permission[];

/**
 * Everything except the three that stay owner-only. An admin who could grant
 * `manage_roles` could grant themselves everything, which would make the
 * owner's authority advisory. `replace_identity` is the same shape.
 */
const ADMIN_PERMISSIONS = EVERY_PERMISSION.filter(
  (p) =>
    p !== "manage_roles" &&
    p !== "manage_server" &&
    p !== "replace_identity" &&
    // Owner-only to begin with: approving a bot grants permissions to
    // something nobody in the room can vouch for.
    p !== "manage_bots",
) as Permission[];

/** Spaced so a custom role slots between two built-ins without renumbering. */
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  { id: "owner", name: "Owner", rank: 100, color: null, permissions: EVERY_PERMISSION },
  { id: "admin", name: "Admin", rank: 80, color: null, permissions: ADMIN_PERMISSIONS },
  { id: "mod", name: "Moderator", rank: 60, color: null, permissions: MOD_PERMISSIONS },
  { id: "member", name: "Member", rank: 40, color: null, permissions: MEMBER_PERMISSIONS },
  { id: "guest", name: "Guest", rank: 10, color: null, permissions: GUEST_PERMISSIONS },
];

/**
 * The permissions that can be used to acquire more permissions. A set of its
 * own because the question is asked away from role editing too — an invite
 * that hands out a role is a role grant nobody watches happen.
 */
export const ESCALATION_PERMISSIONS: ReadonlySet<string> = new Set([
  "manage_roles",
  "manage_server",
  "replace_identity",
  "manage_bots",
]);

/**
 * Only ever given by hand. `admin` holds none of ESCALATION_PERMISSIONS, so a
 * permission test alone would let an invite hand it out.
 */
export const ADMIN_ONLY_ROLE_IDS: ReadonlySet<string> = new Set(["owner", "admin"]);

const SYSTEM_ROLE_IDS: ReadonlySet<string> = new Set(BUILT_IN_ROLES.map((r) => r.id));

export function isSystemRole(roleId: string): boolean {
  return SYSTEM_ROLE_IDS.has(roleId);
}

/** The role somebody falls back to when theirs was deleted or never existed. */
export const FALLBACK_ROLE_ID = "member";

/** The role that always holds every permission, whatever its row says. */
export const OWNER_ROLE_ID = "owner";

/**
 * Slug-shaped, and lowercase: ids are compared exactly, so a role called
 * `Trusted` that is sometimes `trusted` is two roles.
 */
export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidRoleId(value: unknown): value is string {
  return typeof value === "string" && ROLE_ID_PATTERN.test(value);
}

// ── Upgrading an existing server ────────────────────────────────────

/**
 * Which permissions are new since a given schema version, and who should
 * already have them. A build that adds a permission does not change any stored
 * role, so without this the release that made reading a permission would leave
 * every existing role unable to read.
 *
 * Each new permission names the one it was carved out of, or `everyone` if it
 * had no gate before. **Grants only** — nothing here takes a permission away,
 * so an operator's choices survive an upgrade untouched.
 */
export interface PermissionBackfill {
  version: number;
  permission: Permission;
  /** The permission this was carved out of, or `everyone` for a new gate. */
  grantedWith: Permission | "everyone";
}

/** Bump this when adding a batch, and give the new entries the new number. */
export const PERMISSION_SCHEMA_VERSION = 6;

export const PERMISSION_BACKFILLS: readonly PermissionBackfill[] = [
  // Had no gate before: anybody admitted to the server could do all four.
  { version: 2, permission: "read_messages", grantedWith: "everyone" },
  { version: 2, permission: "view_members", grantedWith: "everyone" },
  { version: 2, permission: "report_messages", grantedWith: "everyone" },
  { version: 2, permission: "use_link_previews", grantedWith: "everyone" },

  { version: 2, permission: "edit_own_messages", grantedWith: "send_messages" },
  { version: 2, permission: "delete_own_messages", grantedWith: "send_messages" },

  { version: 2, permission: "deafen_members", grantedWith: "mute_members" },
  { version: 2, permission: "disconnect_members", grantedWith: "mute_members" },
  { version: 2, permission: "view_bans", grantedWith: "ban_members" },
  { version: 2, permission: "view_reports", grantedWith: "manage_reports" },
  { version: 2, permission: "manage_sidebar", grantedWith: "manage_channels" },
  { version: 2, permission: "replace_identity", grantedWith: "manage_server" },
  { version: 2, permission: "view_server_status", grantedWith: "view_audit_log" },

  // GRYT-460. Bots did not exist, so this goes to `manage_server` — the owner.
  { version: 3, permission: "manage_bots", grantedWith: "manage_server" },

  { version: 4, permission: "send_direct_messages", grantedWith: "send_messages" },

  // GRYT-712.
  { version: 5, permission: "start_calls", grantedWith: "send_direct_messages" },

  // GRYT-866.
  { version: 6, permission: "upload_avatar_image", grantedWith: "change_avatar" },
];

/**
 * What a stored role should gain moving between two versions. Pure, because
 * getting it wrong is a silent privilege change in either direction.
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
    // Added as we go, so a chain lands in one pass without ordering the list.
    held.add(entry.permission);
  }

  return gained;
}
