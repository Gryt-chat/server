import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

let db: Database.Database | null = null;

export function getSqliteDb(): Database.Database {
  if (!db) throw new Error("SQLite not initialized. Call initSqlite() first.");
  return db;
}

export async function initSqlite(): Promise<void> {
  const dataDir = process.env.DATA_DIR || "./data";
  const dbPath = join(dataDir, "gryt.db");

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  createSchema(db);
  runMigrations(db);
}

function createSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS server_config (
      id TEXT PRIMARY KEY DEFAULT 'config',
      owner_gryt_user_id TEXT,
      token_version INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      description TEXT,
      icon_url TEXT,
      password_salt TEXT,
      password_hash TEXT,
      password_algo TEXT,
      avatar_max_bytes INTEGER,
      upload_max_bytes INTEGER,
      emoji_max_bytes INTEGER,
      voice_max_bitrate_bps INTEGER,
      profanity_mode TEXT NOT NULL DEFAULT 'censor',
      profanity_censor_style TEXT NOT NULL DEFAULT 'emoji',
      system_channel_id TEXT,
      is_configured INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      gryt_user_id TEXT NOT NULL UNIQUE,
      server_user_id TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      avatar_file_id TEXT,
      joined_with_invite_code TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_gryt_id ON users(gryt_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_server_id ON users(server_user_id);

    CREATE TABLE IF NOT EXISTS roles (
      server_user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bans (
      gryt_user_id TEXT PRIMARY KEY,
      banned_by_server_user_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      position INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      require_push_to_talk INTEGER NOT NULL DEFAULT 0,
      disable_rnnoise INTEGER NOT NULL DEFAULT 0,
      max_bitrate INTEGER,
      esports_mode INTEGER NOT NULL DEFAULT 0,
      text_in_voice INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sidebar_items (
      item_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'channel',
      position INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT,
      spacer_height INTEGER,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender_server_id TEXT NOT NULL,
      text TEXT,
      attachments TEXT,
      reactions TEXT,
      reply_to_message_id TEXT,
      edited_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      s3_key TEXT NOT NULL,
      mime TEXT,
      size INTEGER,
      width INTEGER,
      height INTEGER,
      thumbnail_key TEXT,
      original_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      created_by_server_user_id TEXT,
      expires_at TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses_remaining INTEGER NOT NULL DEFAULT 1,
      uses_consumed INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      event_id TEXT PRIMARY KEY,
      actor_server_user_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token_id TEXT PRIMARY KEY,
      gryt_user_id TEXT NOT NULL,
      server_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_gryt ON refresh_tokens(gryt_user_id);

    CREATE TABLE IF NOT EXISTS emojis (
      name TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      uploaded_by_server_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emoji_jobs (
      job_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      raw_s3_key TEXT NOT NULL,
      raw_content_type TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL DEFAULT 0,
      out_s3_key TEXT,
      out_content_type TEXT,
      file_id TEXT,
      error_message TEXT,
      uploaded_by_server_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emoji_jobs_status ON emoji_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_emoji_jobs_created ON emoji_jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_emoji_jobs_name ON emoji_jobs(name, updated_at);

    CREATE TABLE IF NOT EXISTS reports (
      report_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      reporter_server_user_id TEXT NOT NULL,
      message_text TEXT,
      message_attachments TEXT,
      message_sender_server_id TEXT NOT NULL,
      message_sender_nickname TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by_server_user_id TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

    CREATE TABLE IF NOT EXISTS image_jobs (
      job_id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      raw_s3_key TEXT NOT NULL,
      raw_content_type TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_image_jobs_status ON image_jobs(status, created_at);
  `);
}

function runMigrations(d: Database.Database): void {
  const cols = d.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("created_at")) {
    d.exec("ALTER TABLE users ADD COLUMN created_at TEXT DEFAULT ''");
    d.exec("UPDATE users SET created_at = last_seen WHERE created_at = '' OR created_at IS NULL");
  } else {
    const needsBackfill = d.prepare(
      "SELECT COUNT(*) AS cnt FROM users WHERE created_at = '' OR created_at IS NULL",
    ).get() as { cnt: number };
    if (needsBackfill.cnt > 0) {
      d.exec("UPDATE users SET created_at = last_seen WHERE created_at = '' OR created_at IS NULL");
    }
  }
}

export function toIso(d: Date): string {
  return d.toISOString();
}

export function fromIso(s: string | null | undefined): Date {
  if (!s) return new Date(0);
  return new Date(s);
}

export function fromIsoNullable(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(s);
}

export function boolToInt(b: boolean): number {
  return b ? 1 : 0;
}

export function intToBool(n: number | null | undefined): boolean {
  return n === 1;
}
