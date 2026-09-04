import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

import type { Permission } from "../constants/permissions";
import type { CensorStyle, ProfanityMode } from "../utils/profanityFilter";

export type { CensorStyle, ProfanityMode };

/**
 * What a server asks of somebody who is not already a member. `invite` is the
 * default, `open` lets anyone the server accepts walk in, and `request` sits
 * between: anybody may ask, nobody gets in until an admin says so.
 *
 * **Deliberately not about identity tiers**, which are `GRYT_IDENTITY_TIERS`.
 * Keeping them apart makes "accounts walk in, guests need an invite" a
 * combination rather than a special case.
 */
/**
 * A list rather than a union, because the normaliser that reads the column and
 * the settings patch that writes it both check against it. With their own
 * copies they drifted, and `request` could not be selected at all (GRYT-792).
 */
export const JOIN_POLICIES = ["invite", "open", "request"] as const;

export type JoinPolicy = (typeof JOIN_POLICIES)[number];

/** Whether an untrusted value is one of them. Refuses rather than defaulting. */
export function isJoinPolicy(v: unknown): v is JoinPolicy {
  return typeof v === "string" && (JOIN_POLICIES as readonly string[]).includes(v);
}

/**
 * Somebody asking to be let in, on a `request` server. One row per identity, so
 * asking repeatedly builds no queue. The row is kept after the decision: an
 * approval outlives the connection that asked, and a vanished denial would let
 * them ask again immediately.
 */
export interface ServerJoinRequestRecord {
  gryt_user_id: string;
  nickname: string;
  note: string | null;
  status: "pending" | "approved" | "denied";
  created_at: Date;
  decided_at: Date | null;
  decided_by_server_user_id: string | null;
}

const scrypt = promisify(scryptCb);

// ── User types ───────────────────────────────────────────────────

export interface UserRecord {
  gryt_user_id: string;
  server_user_id: string;
  nickname: string;
  avatar_file_id?: string;
  joined_with_invite_code?: string;
  created_at: Date;
  last_seen: Date;
  last_token_refresh?: Date;
  is_active: boolean;
  /** Server mute and deafen, which belong to the user rather than the socket. */
  is_server_muted: boolean;
  is_server_deafened: boolean;
  /** When a timed mute lifts. Null means it stays until removed. */
  server_mute_expires_at: Date | null;
  /**
   * How many times this member has renamed themselves here, and when they last
   * did. Deliberately a count and a time rather than the names — see the
   * migration in `connection.ts`. Null and zero mean "not since this was
   * recorded", which for rows that predate it is not the same as "never".
   */
  nickname_change_count: number;
  nickname_changed_at: Date | null;
  /**
   * What this member says their DM public key is (GRYT-720). **Opaque here on
   * purpose** — nothing on this server reads, verifies or acts on it, because a
   * server vouching for the binding would be vouching for what a member has to
   * check anyway. Null for anybody who has not sent one.
   */
  dm_key_binding: string | null;
  /**
   * What this member's owl is wearing, as the string `@gryt/owl` encodes, or
   * null when they have no designed look. Stored and passed on without being
   * read — see `utils/wornString.ts`.
   */
  avatar_worn: string | null;
}

// ── Conversation types ───────────────────────────────────────────

/**
 * A conversation that is not a channel. `messages.conversation_id` holds both
 * kinds of id, and which one it is decides who may read it.
 */
export interface ConversationRecord {
  conversation_id: string;
  /**
   * A `dm` has an id derived from its pair, which makes opening it idempotent
   * from either end. A `group` has a random one, because a derived id cannot
   * survive somebody being added.
   */
  kind: "dm" | "group";
  /** What a group is called, when somebody named it. Always null on a `dm`. */
  name: string | null;
  /**
   * A picture somebody uploaded for a group.
   *
   * Null is not "no icon" — it means the clients draw one from the name.
   * Storing a generated image would freeze it against a group that gets
   * renamed.
   */
  icon_file_id: string | null;
  created_by_server_user_id: string | null;
  created_at: Date;
  last_message_at: Date | null;
}

// ── Message types ────────────────────────────────────────────────

export interface Reaction {
  src: string;
  amount: number;
  users: string[];
}

export interface MessageRecord {
  conversation_id: string;
  message_id: string;
  sender_server_id: string;
  text: string | null;
  /**
   * The sealed envelope, when this message was encrypted (GRYT-729).
   *
   * Opaque. Nothing on this server parses it, and `text` is null whenever it is
   * set — there is no plaintext copy anywhere, which is the point.
   */
  sealed?: string | null;
  created_at: Date;
  edited_at?: Date | null;
  attachments: string[] | null;
  reactions: Reaction[] | null;
  reply_to_message_id?: string | null;
  sender_nickname?: string;
  sender_avatar_file_id?: string;
  /** Whether a bot wrote this. Derived from the sender's id, never stored. */
  sender_is_bot?: boolean;
  profanity_matches?: { startIndex: number; endIndex: number }[];
  enriched_attachments?: EnrichedAttachment[];
}

export interface EnrichedAttachment {
  file_id: string;
  mime: string | null;
  size: number | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  has_thumbnail: boolean;
}

export interface FileRecord {
  file_id: string;
  s3_key: string;
  mime: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  thumbnail_key: string | null;
  /** Pixel size of the thumbnail, or null if it was made before this was recorded. */
  thumbnail_px: number | null;
  original_name: string | null;
  /** Dominant colour of the image as #rrggbb, or null if never computed. */
  dominant_color: string | null;
  created_at: Date;
}

// ── Server config types ──────────────────────────────────────────

// 100MB is what Cloudflare allows through on Free and Pro, so a higher default
// only produces a confusing failure for anyone behind a tunnel. Raise them per
// server if you front it yourself; uploads also accept 0, meaning no limit.
//
// Avatars and emoji are re-encoded on the way in, so these govern which source
// files are accepted rather than what is kept. **What bounds the memory is
// MAX_INPUT_PIXELS in utils/imageValidation, not these.**
export const DEFAULT_AVATAR_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_EMOJI_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many files one message may carry.
 *
 * There was no limit. The size cap is per file, so a single message could name
 * a hundred of them and the only bound was how many the sender could upload
 * first.
 */
export const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const DEFAULT_VOICE_MAX_BITRATE_BPS = 96_000;

export interface ServerConfigRecord {
  owner_gryt_user_id: string | null;
  token_version: number;
  display_name: string | null;
  description: string | null;
  icon_url: string | null;
  password_salt: string | null;
  password_hash: string | null;
  password_algo: string | null;
  avatar_max_bytes: number | null;
  upload_max_bytes: number | null;
  emoji_max_bytes: number | null;
  voice_max_bitrate_bps: number | null;
  profanity_mode: ProfanityMode;
  profanity_censor_style: CensorStyle;
  system_channel_id: string | null;
  lan_open: boolean;
  join_policy: JoinPolicy;
  /**
   * Which role somebody lands on first, split by how they proved who they are —
   * an account is durable, a local key is regenerable in two seconds. A public
   * server hands the first `member` and the second `guest`, which one column
   * cannot express.
   *
   * Both default to `member`. Making a server read-only for strangers is a
   * decision in the role editor, not something an upgrade does.
   */
  default_role_account: string;
  default_role_local: string;
  bot_join_policy: BotJoinPolicy;
  discoverable: boolean;
  allow_dms: boolean;
  is_configured: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Which role somebody holds, as a `role_definitions.role_id`. A bare string,
 * since a server defines its own roles.
 *
 * Nothing validates it here. An id with no definition resolves to the fallback
 * role rather than being rejected on read — see `normalizeRoleId`.
 */
export type ServerRole = string;

export interface ServerRoleRecord {
  server_user_id: string;
  role: ServerRole;
  created_at: Date;
  updated_at: Date;
}

/**
 * A role, as opposed to somebody holding one. `rank` answers who may act on
 * whom; `permissions` answers what the holder may do at all. **Deliberately
 * independent** — a rank-90 auditor holding nothing but `view_audit_log`
 * outranks the moderators without gaining any of their powers.
 *
 * `is_system` marks the five that ship. They can be renamed, recoloured and
 * re-permissioned, and cannot be deleted: the defaults fall back to them.
 */
export interface RoleDefinitionRecord {
  role_id: string;
  name: string;
  /** `#rrggbb`, or null to let the client pick. */
  color: string | null;
  rank: number;
  permissions: Permission[];
  is_system: boolean;
  /**
   * Whether an invite may be bound to this role. Off until somebody ticks it,
   * so nothing is invite-grantable by default. Never settable on the owner or
   * admin roles, or on a role carrying a permission that grants permissions —
   * see `services/inviteRoles.ts`, which is where the rules live.
   */
  grantable_by_invite: boolean;
  /**
   * What this role asks before granting itself. Both null means never; both set
   * means **both have to be true** — time alone is how a trusted tier lands on
   * an account that signed up a month ago and never spoke.
   *
   * Only ever a promotion; nothing here takes a role away.
   */
  auto_grant_after_days: number | null;
  auto_grant_after_messages: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Where a bot stands with the operator. */
export type BotStatus = "pending" | "approved" | "denied";

/**
 * A bot, and what an operator agreed to let it do. `requested_permissions` is
 * **written once and never rewritten** — a bot coming back asking for more is
 * asking a question already answered. `granted_permissions` is its entire
 * permission set; bots hold no roles, so no role edit can widen one.
 *
 * `bot_id` is null before the bot exists; `claim_token` is null on a knock and
 * is cleared the moment a registration is claimed.
 */
export interface BotRecord {
  registration_id: string;
  bot_id: string | null;
  claim_token: string | null;
  nickname: string;
  description: string | null;
  requested_permissions: Permission[];
  granted_permissions: Permission[];
  /**
   * How high a bot sits for the checks about acting on people. Zero means it
   * cannot kick, ban or mute anybody, which is where most bots should stay:
   * deleting a message is not acting on a person.
   */
  rank: number;
  status: BotStatus;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
  decided_by_server_user_id: string | null;
}

/**
 * Whether a bot nobody has heard of may leave a knock.
 *
 * `request` records it and admits nothing. `disabled` refuses at the door, for
 * a server that only wants bots it set up itself with a claim token.
 */
export type BotJoinPolicy = "request" | "disabled";

export interface ServerBanRecord {
  gryt_user_id: string;
  banned_by_server_user_id: string;
  reason: string | null;
  created_at: Date;
  /** When the ban lifts by itself. Null means permanent. */
  expires_at: Date | null;
  /** Both null when the user row is gone, so callers must fall back to the id. */
  nickname: string | null;
  banned_by_nickname: string | null;
}

// ── Channel types ────────────────────────────────────────────────

export interface ServerChannelRecord {
  channel_id: string;
  name: string;
  type: "text" | "voice";
  position: number;
  description: string | null;
  require_push_to_talk: boolean;
  disable_rnnoise: boolean;
  max_bitrate: number | null;
  esports_mode: boolean;
  text_in_voice: boolean;
  /**
   * Minimum rank required to post. Null means anybody holding send_messages,
   * which is every channel unless an operator narrows it.
   */
  post_min_rank: number | null;
  /**
   * Which permission scope decides what each role may do here. Null means the
   * channel has no opinion.
   *
   * **Never resolve a permission by reading this.** `channelPermissions.ts` is
   * the one answer and every path goes through it.
   */
  permission_scope_id: string | null;
  /**
   * Both of these are migrated into a permission scope on upgrade and nothing
   * reads them afterwards. They stay so a server rolled back to an older build
   * still enforces the gate it had, which dropping the columns would lose
   * silently. See migrations/rankGates.ts.
   */
  view_min_rank: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Allow grants a permission the role lacks; deny takes one it holds. */
export type RuleEffect = "allow" | "deny";

/**
 * A named set of per-role channel rules, or one channel's private set.
 *
 * `is_template` tells the two apart. A template is shared, named, and listed in
 * server settings; a private scope belongs to the one channel that chose
 * "Custom" and dies with it.
 */
export interface ChannelPermissionScopeRecord {
  scope_id: string;
  name: string | null;
  is_template: boolean;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * One thing a scope changes.
 *
 * There is no row for "inherit" — that is the absence of one. So a scope that
 * hides a channel from three roles is three rows, and a permission added to the
 * catalogue later needs no backfill.
 */
export interface ChannelPermissionRuleRecord {
  scope_id: string;
  role_id: string;
  permission: string;
  effect: RuleEffect;
}

export type ServerSidebarItemKind = "channel" | "separator" | "spacer";

export interface ServerSidebarItemRecord {
  item_id: string;
  kind: ServerSidebarItemKind;
  position: number;
  channel_id: string | null;
  spacer_height: number | null;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}

// ── Invite & audit types ─────────────────────────────────────────

export interface ServerInviteRecord {
  code: string;
  created_at: Date;
  created_by_server_user_id: string | null;
  expires_at: Date | null;
  max_uses: number;
  uses_remaining: number;
  uses_consumed: number;
  /** The role this invite grants on a first join, or null for none. */
  granted_role_id: string | null;
  /**
   * The rank that role carried when it was bound. A role that has climbed
   * since is not the role that was agreed to, so the grant is refused.
   */
  granted_role_rank: number | null;
  revoked: boolean;
  note: string | null;
}

export interface ServerAuditRecord {
  created_at: Date;
  event_id: string;
  actor_server_user_id: string | null;
  action: string;
  target: string | null;
  meta_json: string | null;
}

// ── Emoji types ──────────────────────────────────────────────────

export interface EmojiRecord {
  name: string;
  file_id: string;
  s3_key: string;
  uploaded_by_server_user_id: string;
  created_at: Date;
}

export type EmojiJobStatus = "queued" | "processing" | "done" | "error" | "superseded";

export interface EmojiJobRecord {
  job_id: string;
  name: string;
  status: EmojiJobStatus;
  raw_s3_key: string;
  raw_content_type: string;
  raw_bytes: number;
  out_s3_key: string | null;
  out_content_type: string | null;
  file_id: string | null;
  error_message: string | null;
  uploaded_by_server_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface EmojiJobListItem {
  job_id: string;
  name: string;
  status: EmojiJobStatus;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

// ── Image job types ─────────────────────────────────────────────

export type ImageJobStatus = "queued" | "processing" | "done" | "error";

export interface ImageJobRecord {
  job_id: string;
  file_id: string;
  status: ImageJobStatus;
  raw_s3_key: string;
  raw_content_type: string;
  raw_bytes: number;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

// ── Token types ──────────────────────────────────────────────────

export interface RefreshTokenRecord {
  token_id: string;
  gryt_user_id: string;
  server_user_id: string;
  created_at: Date;
  expires_at: Date;
  revoked: boolean;
}

// ── Report types ─────────────────────────────────────────────────

export interface ReportRecord {
  report_id: string;
  message_id: string;
  conversation_id: string;
  reporter_server_user_id: string;
  message_text: string | null;
  message_attachments: string[] | null;
  message_sender_server_id: string;
  message_sender_nickname: string | null;
  status: "pending" | "approved" | "deleted";
  resolved_by_server_user_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

/**
 * A report about a person rather than a message. `status` deliberately does not
 * reuse the message queue's "approved", which applied to a person reads as
 * approving of them.
 */
export interface UserReportRecord {
  report_id: string;
  reported_server_user_id: string;
  /** Snapshot, so the row stays readable after they leave or are renamed. */
  reported_nickname: string | null;
  reporter_server_user_id: string;
  /** Snapshot too — see the table comment; the reporter often leaves. */
  reporter_nickname: string | null;
  reason: string;
  status: "pending" | "dismissed" | "actioned";
  resolved_by_server_user_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

// ── Webhook types ────────────────────────────────────────────────

export interface WebhookRecord {
  webhook_id: string;
  token: string;
  channel_id: string;
  display_name: string;
  avatar_file_id: string | null;
  created_by_server_user_id: string;
  created_at: Date;
  updated_at: Date;
}

// ── Pure utility functions (no DB dependency) ────────────────────

export async function hashServerPassword(password: string): Promise<{ saltB64: string; hashB64: string; algo: string }> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 32)) as Buffer;
  return { saltB64: salt.toString("base64"), hashB64: key.toString("base64"), algo: "scrypt" };
}

export async function verifyServerPassword(password: string, saltB64: string, hashB64: string): Promise<boolean> {
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
