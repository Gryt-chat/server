import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { types } from "cassandra-driver";

import { getScyllaClient } from "./scylla";
import { getUserByGrytId } from "./users";

const scrypt = promisify(scryptCb);

export const DEFAULT_AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5MB
export const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20MB (matches typical reverse proxy defaults)
export const DEFAULT_VOICE_MAX_BITRATE_BPS = 96_000; // 96kbps Opus cap (low-latency friendly default)

import type { ProfanityMode } from "../utils/profanityFilter";

export interface ServerConfigRecord {
  owner_gryt_user_id: string | null;
  token_version: number;
  display_name: string | null;
  description: string | null;
  icon_url: string | null;
  password_salt: string | null; // base64
  password_hash: string | null; // base64
  password_algo: string | null; // e.g. "scrypt"
  avatar_max_bytes: number | null;
  upload_max_bytes: number | null;
  voice_max_bitrate_bps: number | null;
  profanity_mode: ProfanityMode;
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

function rowToServerConfig(r: types.Row): ServerConfigRecord {
  return {
    owner_gryt_user_id: r["owner_gryt_user_id"] ?? null,
    token_version: typeof r["token_version"] === "number" ? r["token_version"] : 0,
    display_name: r["display_name"] ?? null,
    description: r["description"] ?? null,
    icon_url: r["icon_url"] ?? null,
    password_salt: r["password_salt"] ?? null,
    password_hash: r["password_hash"] ?? null,
    password_algo: r["password_algo"] ?? null,
    avatar_max_bytes: typeof r["avatar_max_bytes"] === "number" ? r["avatar_max_bytes"] : (r["avatar_max_bytes"] == null ? null : Number(r["avatar_max_bytes"])),
    upload_max_bytes: typeof r["upload_max_bytes"] === "number" ? r["upload_max_bytes"] : (r["upload_max_bytes"] == null ? null : Number(r["upload_max_bytes"])),
    voice_max_bitrate_bps: typeof r["voice_max_bitrate_bps"] === "number" ? r["voice_max_bitrate_bps"] : (r["voice_max_bitrate_bps"] == null ? null : Number(r["voice_max_bitrate_bps"])),
    profanity_mode: normalizeProfanityMode(r["profanity_mode"]),
    is_configured: typeof r["is_configured"] === "boolean" ? r["is_configured"] : false,
    created_at: r["created_at"] ?? new Date(0),
    updated_at: r["updated_at"] ?? new Date(0),
  };
}

const VALID_PROFANITY_MODES: ProfanityMode[] = ["off", "flag", "censor", "block"];

function normalizeProfanityMode(v: unknown): ProfanityMode {
  const s = String(v || "").toLowerCase();
  if (VALID_PROFANITY_MODES.includes(s as ProfanityMode)) return s as ProfanityMode;
  return "off";
}

function normalizeRole(role: unknown): ServerRole {
  const r = String(role || "").toLowerCase();
  if (r === "owner" || r === "admin" || r === "mod" || r === "member") return r;
  return "member";
}

const SERVER_CONFIG_ID = "config";

export async function getServerConfig(): Promise<ServerConfigRecord | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT owner_gryt_user_id, token_version, display_name, description, icon_url, password_salt, password_hash, password_algo, avatar_max_bytes, upload_max_bytes, voice_max_bitrate_bps, profanity_mode, is_configured, created_at, updated_at
     FROM server_config_singleton WHERE id = ?`,
    [SERVER_CONFIG_ID],
    { prepare: true }
  );
  const r = rs.first();
  if (!r) return null;
  return rowToServerConfig(r);
}

export async function createServerConfigIfNotExists(seed?: {
  displayName?: string;
  description?: string;
  iconUrl?: string;
}): Promise<{ applied: boolean; config: ServerConfigRecord }> {
  const c = getScyllaClient();
  const now = new Date();
  const displayName = seed?.displayName ?? null;
  const description = seed?.description ?? null;
  const iconUrl = seed?.iconUrl ?? null;

  const rs = await c.execute(
    `INSERT INTO server_config_singleton (id, owner_gryt_user_id, token_version, display_name, description, icon_url, password_salt, password_hash, password_algo, avatar_max_bytes, upload_max_bytes, voice_max_bitrate_bps, profanity_mode, is_configured, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
    [SERVER_CONFIG_ID, null, 0, displayName, description, iconUrl, null, null, null, DEFAULT_AVATAR_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_VOICE_MAX_BITRATE_BPS, "off", false, now, now],
    { prepare: true }
  );

  const r = rs.first();
  const applied = !!r?.["[applied]"];
  const config = (await getServerConfig()) || {
    owner_gryt_user_id: null,
    token_version: 0,
    display_name: displayName,
    description,
    icon_url: iconUrl,
    password_salt: null,
    password_hash: null,
    password_algo: null,
    avatar_max_bytes: DEFAULT_AVATAR_MAX_BYTES,
    upload_max_bytes: DEFAULT_UPLOAD_MAX_BYTES,
    voice_max_bitrate_bps: DEFAULT_VOICE_MAX_BITRATE_BPS,
    profanity_mode: "off",
    is_configured: false,
    created_at: now,
    updated_at: now,
  };
  return { applied, config };
}

export async function claimServerOwner(grytUserId: string): Promise<{ claimed: boolean; owner: string | null }> {
  const c = getScyllaClient();
  await createServerConfigIfNotExists();

  const rs = await c.execute(
    `UPDATE server_config_singleton SET owner_gryt_user_id = ? WHERE id = ? IF owner_gryt_user_id = null`,
    [grytUserId, SERVER_CONFIG_ID],
    { prepare: true }
  );
  const r = rs.first();
  const claimed = !!r?.["[applied]"];
  const owner = (r?.["owner_gryt_user_id"] as string | null | undefined) ?? (await getServerConfig())?.owner_gryt_user_id ?? null;
  return { claimed, owner };
}

export async function setServerOwner(grytUserId: string): Promise<ServerConfigRecord> {
  const c = getScyllaClient();
  const now = new Date();
  await createServerConfigIfNotExists();
  const nextOwner = String(grytUserId || "").trim();
  if (!nextOwner) throw new Error("setServerOwner: grytUserId is required");

  await c.execute(
    `UPDATE server_config_singleton
     SET owner_gryt_user_id = ?, updated_at = ?
     WHERE id = ?`,
    [nextOwner, now, SERVER_CONFIG_ID],
    { prepare: true }
  );

  const updated = await getServerConfig();
  if (!updated) throw new Error("Failed to set server owner");
  return updated;
}

export async function demoteAllOwnerRoles(): Promise<{ demoted: number }> {
  const roles = await listServerRoles();
  let demoted = 0;
  for (const r of roles) {
    if (r.role === "owner") {
      await setServerRole(r.server_user_id, "member");
      demoted += 1;
    }
  }
  return { demoted };
}

export async function ensureOwnerRoleForGrytUser(grytUserId: string): Promise<{ applied: boolean; serverUserId?: string }> {
  const u = await getUserByGrytId(grytUserId);
  if (!u) return { applied: false };
  await setServerRole(u.server_user_id, "owner");
  return { applied: true, serverUserId: u.server_user_id };
}

export async function clearServerOwner(opts?: { clearConfigured?: boolean }): Promise<ServerConfigRecord> {
  const c = getScyllaClient();
  const now = new Date();
  await createServerConfigIfNotExists();

  const clearConfigured = opts?.clearConfigured !== false;

  if (clearConfigured) {
    await c.execute(
      `UPDATE server_config_singleton
       SET owner_gryt_user_id = ?, is_configured = ?, updated_at = ?
       WHERE id = ?`,
      [null, false, now, SERVER_CONFIG_ID],
      { prepare: true }
    );
  } else {
    await c.execute(
      `UPDATE server_config_singleton
       SET owner_gryt_user_id = ?, updated_at = ?
       WHERE id = ?`,
      [null, now, SERVER_CONFIG_ID],
      { prepare: true }
    );
  }

  const updated = await getServerConfig();
  if (!updated) throw new Error("Failed to clear server owner");
  return updated;
}

export async function setServerTokenVersion(expected: number, next: number): Promise<{ applied: boolean; version: number }> {
  const c = getScyllaClient();
  await createServerConfigIfNotExists();
  const rs = await c.execute(
    `UPDATE server_config_singleton SET token_version = ? WHERE id = ? IF token_version = ?`,
    [next, SERVER_CONFIG_ID, expected],
    { prepare: true }
  );
  const r = rs.first();
  const applied = !!r?.["[applied]"];
  const version = (applied ? next : (typeof r?.["token_version"] === "number" ? r["token_version"] : expected));
  return { applied, version };
}

export async function incrementServerTokenVersion(): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const cfg = await getServerConfig();
    const cur = cfg?.token_version ?? 0;
    const next = cur + 1;
    const res = await setServerTokenVersion(cur, next);
    if (res.applied) return next;
  }
  const cfg = await getServerConfig();
  return cfg?.token_version ?? 0;
}

export async function updateServerConfig(patch: {
  displayName?: string | null;
  description?: string | null;
  iconUrl?: string | null;
  passwordSalt?: string | null;
  passwordHash?: string | null;
  passwordAlgo?: string | null;
  avatarMaxBytes?: number | null;
  uploadMaxBytes?: number | null;
  voiceMaxBitrateBps?: number | null;
  profanityMode?: ProfanityMode;
  isConfigured?: boolean;
}): Promise<ServerConfigRecord> {
  const c = getScyllaClient();
  const now = new Date();

  await createServerConfigIfNotExists();
  const current = await getServerConfig();
  const has = (k: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, k);
  const next = {
    display_name: has("displayName") ? (patch.displayName ?? null) : (current?.display_name ?? null),
    description: has("description") ? (patch.description ?? null) : (current?.description ?? null),
    icon_url: has("iconUrl") ? (patch.iconUrl ?? null) : (current?.icon_url ?? null),
    password_salt: has("passwordSalt") ? (patch.passwordSalt ?? null) : (current?.password_salt ?? null),
    password_hash: has("passwordHash") ? (patch.passwordHash ?? null) : (current?.password_hash ?? null),
    password_algo: has("passwordAlgo") ? (patch.passwordAlgo ?? null) : (current?.password_algo ?? null),
    avatar_max_bytes: has("avatarMaxBytes") ? (patch.avatarMaxBytes ?? null) : (current?.avatar_max_bytes ?? null),
    upload_max_bytes: has("uploadMaxBytes") ? (patch.uploadMaxBytes ?? null) : (current?.upload_max_bytes ?? null),
    voice_max_bitrate_bps: has("voiceMaxBitrateBps") ? (patch.voiceMaxBitrateBps ?? null) : (current?.voice_max_bitrate_bps ?? null),
    profanity_mode: has("profanityMode") ? normalizeProfanityMode(patch.profanityMode) : (current?.profanity_mode ?? "off"),
    is_configured: typeof patch.isConfigured === "boolean" ? patch.isConfigured : (current?.is_configured ?? false),
  };

  await c.execute(
    `UPDATE server_config_singleton
     SET display_name = ?, description = ?, icon_url = ?, password_salt = ?, password_hash = ?, password_algo = ?, avatar_max_bytes = ?, upload_max_bytes = ?, voice_max_bitrate_bps = ?, profanity_mode = ?, is_configured = ?, updated_at = ?
     WHERE id = ?`,
    [next.display_name, next.description, next.icon_url, next.password_salt, next.password_hash, next.password_algo, next.avatar_max_bytes, next.upload_max_bytes, next.voice_max_bitrate_bps, next.profanity_mode, next.is_configured, now, SERVER_CONFIG_ID],
    { prepare: true }
  );

  const updated = await getServerConfig();
  if (!updated) throw new Error("Failed to update server config");
  return updated;
}

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

export async function getServerRole(serverUserId: string): Promise<ServerRole | null> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT role FROM server_roles_by_user WHERE server_user_id = ?`,
    [serverUserId],
    { prepare: true }
  );
  const r = rs.first();
  if (!r) return null;
  return normalizeRole(r["role"]);
}

export async function setServerRole(serverUserId: string, role: ServerRole): Promise<void> {
  const c = getScyllaClient();
  const now = new Date();
  await c.execute(
    `INSERT INTO server_roles_by_user (server_user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [serverUserId, role, now, now],
    { prepare: true }
  );
}

export async function listServerRoles(): Promise<ServerRoleRecord[]> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT server_user_id, role, created_at, updated_at FROM server_roles_by_user`,
    [],
    { prepare: true }
  );
  return rs.rows.map((r) => ({
    server_user_id: r["server_user_id"],
    role: normalizeRole(r["role"]),
    created_at: r["created_at"] ?? new Date(0),
    updated_at: r["updated_at"] ?? new Date(0),
  }));
}

// ── Bans ──────────────────────────────────────────────────────────────

export interface ServerBanRecord {
  gryt_user_id: string;
  banned_by_server_user_id: string;
  reason: string | null;
  created_at: Date;
}

export async function banUser(grytUserId: string, bannedByServerUserId: string, reason?: string): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `INSERT INTO server_bans_by_gryt_id (gryt_user_id, banned_by_server_user_id, reason, created_at) VALUES (?, ?, ?, ?)`,
    [grytUserId, bannedByServerUserId, reason ?? null, new Date()],
    { prepare: true }
  );
}

export async function unbanUser(grytUserId: string): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `DELETE FROM server_bans_by_gryt_id WHERE gryt_user_id = ?`,
    [grytUserId],
    { prepare: true }
  );
}

export async function isUserBanned(grytUserId: string): Promise<boolean> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT gryt_user_id FROM server_bans_by_gryt_id WHERE gryt_user_id = ?`,
    [grytUserId],
    { prepare: true }
  );
  return rs.rowLength > 0;
}

export async function listBans(): Promise<ServerBanRecord[]> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT gryt_user_id, banned_by_server_user_id, reason, created_at FROM server_bans_by_gryt_id`,
    [],
    { prepare: true }
  );
  return rs.rows.map((r) => ({
    gryt_user_id: r["gryt_user_id"],
    banned_by_server_user_id: r["banned_by_server_user_id"] ?? "",
    reason: r["reason"] ?? null,
    created_at: r["created_at"] ?? new Date(0),
  }));
}
