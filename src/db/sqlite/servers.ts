import {
  DEFAULT_AVATAR_MAX_BYTES,
  DEFAULT_EMOJI_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_VOICE_MAX_BITRATE_BPS,
} from "../interfaces";
import type {
  CensorStyle,
  ProfanityMode,
  ServerBanRecord,
  ServerConfigRecord,
  ServerRole,
  ServerRoleRecord,
} from "../interfaces";
import { normalizeCensorStyle } from "../../utils/profanityFilter";
import { fromIso, getSqliteDb, toIso } from "./connection";
import { getUserByGrytId } from "./users";

const VALID_PROFANITY_MODES: ProfanityMode[] = ["off", "flag", "censor", "block"];

function normalizeProfanityMode(v: unknown): ProfanityMode {
  const s = String(v || "").toLowerCase();
  if (VALID_PROFANITY_MODES.includes(s as ProfanityMode)) return s as ProfanityMode;
  return "censor";
}

function normalizeRole(role: unknown): ServerRole {
  const r = String(role || "").toLowerCase();
  if (r === "owner" || r === "admin" || r === "mod" || r === "member") return r;
  return "member";
}

function rowToConfig(r: Record<string, unknown>): ServerConfigRecord {
  return {
    owner_gryt_user_id: (r.owner_gryt_user_id as string) ?? null,
    token_version: (r.token_version as number) ?? 0,
    display_name: (r.display_name as string) ?? null,
    description: (r.description as string) ?? null,
    icon_url: (r.icon_url as string) ?? null,
    password_salt: (r.password_salt as string) ?? null,
    password_hash: (r.password_hash as string) ?? null,
    password_algo: (r.password_algo as string) ?? null,
    avatar_max_bytes: r.avatar_max_bytes != null ? Number(r.avatar_max_bytes) : null,
    upload_max_bytes: r.upload_max_bytes != null ? Number(r.upload_max_bytes) : null,
    emoji_max_bytes: r.emoji_max_bytes != null ? Number(r.emoji_max_bytes) : null,
    voice_max_bitrate_bps: r.voice_max_bitrate_bps != null ? Number(r.voice_max_bitrate_bps) : null,
    profanity_mode: normalizeProfanityMode(r.profanity_mode),
    profanity_censor_style: normalizeCensorStyle(r.profanity_censor_style),
    system_channel_id: (r.system_channel_id as string) ?? null,
    is_configured: (r.is_configured as number) === 1,
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

const SERVER_CONFIG_ID = "config";

export async function getServerConfig(): Promise<ServerConfigRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM server_config WHERE id = ?`).get(SERVER_CONFIG_ID) as Record<string, unknown> | undefined;
  return row ? rowToConfig(row) : null;
}

export async function createServerConfigIfNotExists(seed?: {
  displayName?: string;
  description?: string;
  iconUrl?: string;
}): Promise<{ applied: boolean; config: ServerConfigRecord }> {
  const db = getSqliteDb();
  const now = new Date();
  const existing = await getServerConfig();
  if (existing) return { applied: false, config: existing };

  db.prepare(
    `INSERT OR IGNORE INTO server_config (id, owner_gryt_user_id, token_version, display_name, description, icon_url, avatar_max_bytes, upload_max_bytes, emoji_max_bytes, voice_max_bitrate_bps, profanity_mode, profanity_censor_style, is_configured, created_at, updated_at)
     VALUES (?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, 'censor', 'emoji', 0, ?, ?)`
  ).run(SERVER_CONFIG_ID, seed?.displayName ?? null, seed?.description ?? null, seed?.iconUrl ?? null, DEFAULT_AVATAR_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_EMOJI_MAX_BYTES, DEFAULT_VOICE_MAX_BITRATE_BPS, toIso(now), toIso(now));

  const config = (await getServerConfig())!;
  return { applied: true, config };
}

export async function claimServerOwner(grytUserId: string): Promise<{ claimed: boolean; owner: string | null }> {
  const db = getSqliteDb();
  await createServerConfigIfNotExists();
  const result = db.prepare(
    `UPDATE server_config SET owner_gryt_user_id = ? WHERE id = ? AND owner_gryt_user_id IS NULL`
  ).run(grytUserId, SERVER_CONFIG_ID);
  if (result.changes > 0) return { claimed: true, owner: grytUserId };
  const cfg = await getServerConfig();
  return { claimed: false, owner: cfg?.owner_gryt_user_id ?? null };
}

export async function setServerOwner(grytUserId: string): Promise<ServerConfigRecord> {
  const db = getSqliteDb();
  const now = new Date();
  await createServerConfigIfNotExists();
  const nextOwner = String(grytUserId || "").trim();
  if (!nextOwner) throw new Error("setServerOwner: grytUserId is required");
  db.prepare(`UPDATE server_config SET owner_gryt_user_id = ?, updated_at = ? WHERE id = ?`).run(nextOwner, toIso(now), SERVER_CONFIG_ID);
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
  const db = getSqliteDb();
  const now = new Date();
  await createServerConfigIfNotExists();
  const clearConfigured = opts?.clearConfigured !== false;
  if (clearConfigured) {
    db.prepare(`UPDATE server_config SET owner_gryt_user_id = NULL, is_configured = 0, updated_at = ? WHERE id = ?`).run(toIso(now), SERVER_CONFIG_ID);
  } else {
    db.prepare(`UPDATE server_config SET owner_gryt_user_id = NULL, updated_at = ? WHERE id = ?`).run(toIso(now), SERVER_CONFIG_ID);
  }
  const updated = await getServerConfig();
  if (!updated) throw new Error("Failed to clear server owner");
  return updated;
}

export async function setServerTokenVersion(expected: number, next: number): Promise<{ applied: boolean; version: number }> {
  const db = getSqliteDb();
  await createServerConfigIfNotExists();
  const result = db.prepare(`UPDATE server_config SET token_version = ? WHERE id = ? AND token_version = ?`).run(next, SERVER_CONFIG_ID, expected);
  if (result.changes > 0) return { applied: true, version: next };
  const cfg = await getServerConfig();
  return { applied: false, version: cfg?.token_version ?? expected };
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
  emojiMaxBytes?: number | null;
  voiceMaxBitrateBps?: number | null;
  profanityMode?: ProfanityMode;
  profanityCensorStyle?: CensorStyle;
  systemChannelId?: string | null;
  isConfigured?: boolean;
}): Promise<ServerConfigRecord> {
  const db = getSqliteDb();
  const now = new Date();
  await createServerConfigIfNotExists();

  const FIELD_MAP: Record<string, { col: string; transform?: (v: unknown) => unknown }> = {
    displayName: { col: "display_name" },
    description: { col: "description" },
    iconUrl: { col: "icon_url" },
    passwordSalt: { col: "password_salt" },
    passwordHash: { col: "password_hash" },
    passwordAlgo: { col: "password_algo" },
    avatarMaxBytes: { col: "avatar_max_bytes" },
    uploadMaxBytes: { col: "upload_max_bytes" },
    emojiMaxBytes: { col: "emoji_max_bytes" },
    voiceMaxBitrateBps: { col: "voice_max_bitrate_bps" },
    profanityMode: { col: "profanity_mode", transform: (v) => normalizeProfanityMode(v) },
    profanityCensorStyle: { col: "profanity_censor_style", transform: (v) => normalizeCensorStyle(v as string) },
    systemChannelId: { col: "system_channel_id" },
    isConfigured: { col: "is_configured", transform: (v) => v ? 1 : 0 },
  };

  const setClauses: string[] = ["updated_at = ?"];
  const params: unknown[] = [toIso(now)];

  for (const [key, { col, transform }] of Object.entries(FIELD_MAP)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const raw = (patch as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    setClauses.push(`${col} = ?`);
    params.push(transform ? transform(raw) : (raw ?? null));
  }
  params.push(SERVER_CONFIG_ID);
  db.prepare(`UPDATE server_config SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

  const updated = await getServerConfig();
  if (!updated) throw new Error("Failed to update server config");
  return updated;
}

export async function getServerRole(serverUserId: string): Promise<ServerRole | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT role FROM roles WHERE server_user_id = ?`).get(serverUserId) as { role: string } | undefined;
  return row ? normalizeRole(row.role) : null;
}

export async function setServerRole(serverUserId: string, role: ServerRole): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  db.prepare(
    `INSERT INTO roles (server_user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(server_user_id) DO UPDATE SET role = ?, updated_at = ?`
  ).run(serverUserId, role, now, now, role, now);
}

export async function listServerRoles(): Promise<ServerRoleRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM roles`).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    server_user_id: r.server_user_id as string,
    role: normalizeRole(r.role),
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  }));
}

export async function banUser(grytUserId: string, bannedByServerUserId: string, reason?: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(
    `INSERT OR REPLACE INTO bans (gryt_user_id, banned_by_server_user_id, reason, created_at) VALUES (?, ?, ?, ?)`
  ).run(grytUserId, bannedByServerUserId, reason ?? null, toIso(new Date()));
}

export async function unbanUser(grytUserId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`DELETE FROM bans WHERE gryt_user_id = ?`).run(grytUserId);
}

export async function isUserBanned(grytUserId: string): Promise<boolean> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT 1 FROM bans WHERE gryt_user_id = ?`).get(grytUserId);
  return !!row;
}

export async function listBans(): Promise<ServerBanRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM bans`).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    gryt_user_id: r.gryt_user_id as string,
    banned_by_server_user_id: (r.banned_by_server_user_id as string) ?? "",
    reason: (r.reason as string) ?? null,
    created_at: fromIso(r.created_at as string),
  }));
}
