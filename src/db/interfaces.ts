import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

import type { CensorStyle, ProfanityMode } from "../utils/profanityFilter";

export type { CensorStyle, ProfanityMode };

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
  original_name: string | null;
  created_at: Date;
}

// ── Server config types ──────────────────────────────────────────

export const DEFAULT_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_EMOJI_MAX_BYTES = 5 * 1024 * 1024;
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
  is_configured: boolean;
  created_at: Date;
  updated_at: Date;
}

export type ServerRole = "owner" | "admin" | "mod" | "member";

export interface ServerRoleRecord {
  server_user_id: string;
  role: ServerRole;
  created_at: Date;
  updated_at: Date;
}

export interface ServerBanRecord {
  gryt_user_id: string;
  banned_by_server_user_id: string;
  reason: string | null;
  created_at: Date;
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
