import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

import type { Permission } from "../constants/permissions";
import type { CensorStyle, ProfanityMode } from "../utils/profanityFilter";

export type { CensorStyle, ProfanityMode };

/**
 * What a server asks of somebody who is not already a member.
 *
 * `invite` is the default and was the only behaviour before this existed: an
 * invite code, or a private IP when `lan_open` is set. `open` lets anyone the
 * server already accepts walk in — which is what makes "you don't need an
 * account to join this server" mean anything for a public server.
 *
 * Deliberately not about identity tiers. Which identities a server takes is
 * `GRYT_IDENTITY_TIERS`; this is how hard it is to get in once you have one.
 * Keeping them apart means "accounts walk in, guests need an invite" is a
 * combination rather than a special case.
 *
 * `request` sits between the other two: anybody may ask, nobody gets in until
 * an admin says so. It is the answer to a server that wants to be findable
 * without being unattended — `open` lets anyone walk in, and `invite` makes a
 * shareable link the whole security model.
 */
export type JoinPolicy = "invite" | "open" | "request";

/**
 * Somebody asking to be let in, on a `request` server.
 *
 * One row per identity, so asking repeatedly does not build a queue. `status`
 * is kept after the decision rather than deleting the row: an approval has to
 * outlive the connection that asked for it, because the person is told to come
 * back rather than held open, and a denial that vanished would let them ask
 * again immediately.
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
  created_at: Date;
  edited_at?: Date | null;
  attachments: string[] | null;
  reactions: Reaction[] | null;
  reply_to_message_id?: string | null;
  sender_nickname?: string;
  sender_avatar_file_id?: string;
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

// All three sit at 100MB, which is what Cloudflare allows through on Free and
// Pro. Anything larger is refused at the edge before it reaches us, so a higher
// default would only produce a confusing failure for anyone behind a tunnel —
// which is how Gryt is normally reached. Raise them per server if you front it
// yourself; uploads additionally accept 0, meaning no limit at all.
//
// Avatars and emoji were 5MB. They are re-encoded on the way in and only the
// re-encoded result is stored, so the number governs which source files are
// accepted rather than what is kept. What bounds the memory is MAX_INPUT_PIXELS
// in utils/imageValidation, not these.
export const DEFAULT_AVATAR_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_EMOJI_MAX_BYTES = 100 * 1024 * 1024;
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
   * Which role somebody lands on the first time they join, split by how they
   * proved who they are.
   *
   * Two columns rather than one because the whole point of the split is that a
   * server can trust the two differently: an account is a durable identity a CA
   * vouched for, a local key is regenerable in two seconds. A public server
   * hands the first `member` and the second `guest`, and that combination is
   * not expressible with a single default.
   *
   * Both default to `member`, which is what every server did before these
   * columns existed. Turning a server into a read-only-for-strangers one is a
   * decision an operator makes in the role editor, not something an upgrade
   * does to them.
   */
  default_role_account: string;
  default_role_local: string;
  discoverable: boolean;
  is_configured: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Which role somebody holds, as a `role_definitions.role_id`.
 *
 * A bare string rather than the four names it used to be. The four are still
 * there — seeded as system roles — but a server can now define its own, and a
 * union that had to be widened every time somebody added "Contributor" would
 * not be a type, it would be a schema.
 *
 * Nothing validates the value here. What a role *means* lives in
 * `role_definitions`, and an id with no definition behind it resolves to the
 * fallback role rather than being rejected on read — see `normalizeRoleId`.
 */
export type ServerRole = string;

export interface ServerRoleRecord {
  server_user_id: string;
  role: ServerRole;
  created_at: Date;
  updated_at: Date;
}

/**
 * A role, as opposed to somebody holding one.
 *
 * `rank` answers who may act on whom — kick, ban, mute and role assignment all
 * refuse against an equal or higher rank. `permissions` answers what the holder
 * may do at all. They are deliberately independent: a bot with `send_messages`
 * and rank 5 is below everybody and can still talk, and a rank-90 auditor with
 * nothing but `view_audit_log` outranks the moderators without gaining any of
 * their powers.
 *
 * `is_system` marks the five that ship with the server. They can be renamed,
 * recoloured and re-permissioned; they cannot be deleted, because the join
 * defaults and the owner fall back to them.
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
   * What this role asks of somebody before it grants itself to them.
   *
   * Both null means it never does. Both set means both have to be true — a
   * fortnight *and* fifty messages, not either. The other reading, where time
   * alone is enough, is how a public server's trusted tier ends up on an
   * account that signed up a month ago and has never spoken.
   *
   * Only ever a promotion. A member already holding a role of equal or higher
   * rank is left alone, and nothing here ever takes a role away: somebody who
   * goes quiet does not slide back down.
   */
  auto_grant_after_days: number | null;
  auto_grant_after_messages: number | null;
  created_at: Date;
  updated_at: Date;
}

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
  created_at: Date;
  updated_at: Date;
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
