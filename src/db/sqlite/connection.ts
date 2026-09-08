import { existsSync, mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "path";

import { AVATAR_THUMB_PX } from "../../constants/media";
import { migrateRankGatesToScopes } from "./rankGateMigration";
import {
  backfillFor,
  BUILT_IN_ROLES,
  PERMISSION_SCHEMA_VERSION,
} from "../../constants/permissions";

/** So the query modules can type their parameters without importing the driver.
    This file is the only one that knows which driver is in use. */
export type { SQLInputValue } from "node:sqlite";

let db: DatabaseSync | null = null;

export function getSqliteDb(): DatabaseSync {
  if (!db) throw new Error("SQLite not initialized. Call initSqlite() first.");
  return db;
}

export async function initSqlite(): Promise<void> {
  const dataDir = process.env.DATA_DIR || "./data";
  const dbPath = join(dataDir, "gryt.db");

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(dbPath);

  // The order matters: WAL is what lets the image worker write to this file from
  // its own process while the server holds it open.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  createSchema(db);
  runMigrations(db);
}

function createSchema(d: DatabaseSync): void {
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
      avatar_thumb_px INTEGER,
      lan_open INTEGER NOT NULL DEFAULT 0,
      discoverable INTEGER NOT NULL DEFAULT 1,
      allow_dms INTEGER NOT NULL DEFAULT 1,
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
      is_server_muted INTEGER NOT NULL DEFAULT 0,
      is_server_deafened INTEGER NOT NULL DEFAULT 0,
      server_mute_expires_at TEXT,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_gryt_id ON users(gryt_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_server_id ON users(server_user_id);

    -- Who holds which role. One row per pair, so somebody can hold several.
    --
    -- The primary key used to be server_user_id alone, which made a second role
    -- unrepresentable rather than merely unimplemented. Servers replacing a
    -- Discord arrive with roles that stack -- a moderator who is also a
    -- contributor -- and collapsing those into one on the way in loses the part
    -- the operator cared about. See migrateRolesToMultiple below for how an
    -- existing database gets here.
    --
    -- Which of somebody's roles is the one shown next to their name is not
    -- decided here. It is the highest ranked, and rank lives in
    -- role_definitions, so services/permissions.ts answers it.
    CREATE TABLE IF NOT EXISTS roles (
      server_user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (server_user_id, role)
    );
    -- Every holder of one role: what deleting a role definition asks, and what
    -- the member list asks once per connect.
    CREATE INDEX IF NOT EXISTS idx_roles_role ON roles(role);

    -- What a role is, as opposed to who holds one. roles.role points at role_id
    -- here, deliberately without a foreign key: a role that is deleted while
    -- somebody holds it leaves that row dangling, and the read path resolves a
    -- dangling id to the fallback role. ON DELETE SET DEFAULT would have to
    -- name a default in the schema, and there is no single right answer -- the
    -- fallback is a policy decision that belongs in code.
    --
    -- Permissions are a JSON array of strings rather than a bitfield or a join
    -- table. A bitfield saves nothing at this size and turns "which permissions
    -- does this role have" into an archaeology exercise the first time a bit is
    -- reused; a join table is three more queries for a row that is always read
    -- whole.
    -- Where migrations that are not "does this column exist" record what they
    -- have done. The permission backfill needs it: what it has to do depends on
    -- which release last touched the role rows, and no column shape says that.
    --
    -- Not a column on server_config, which is where a single-row setting would
    -- normally go, because that row is created lazily on first join — so a
    -- database that has never been joined has nowhere to write the stamp.
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Bots, and what an operator agreed to let each one do.
    --
    -- Deliberately not the roles table. A bot's permissions are frozen at the
    -- moment somebody approved them and belong to the bot, not to a tier it
    -- shares with others: editing a role must never be a way to widen what a
    -- bot can do, and a bot must never be able to widen it by asking again.
    --
    -- bot_id is null until an identity claims the row, which is how a
    -- pre-approved registration works: the operator writes down what a bot may
    -- do before there is a bot, hands out claim_token, and the first identity to
    -- present it becomes that registration. A knock arrives the other way round,
    -- with the id known and no token.
    CREATE TABLE IF NOT EXISTS bots (
      registration_id TEXT PRIMARY KEY,
      bot_id TEXT UNIQUE,
      claim_token TEXT UNIQUE,
      nickname TEXT NOT NULL,
      description TEXT,
      requested_permissions TEXT NOT NULL DEFAULT '[]',
      granted_permissions TEXT NOT NULL DEFAULT '[]',
      rank INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by_server_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);

    CREATE TABLE IF NOT EXISTS role_definitions (
      role_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      rank INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bans (
      gryt_user_id TEXT PRIMARY KEY,
      banned_by_server_user_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    -- Who somebody does not want to hear from.
    --
    -- A personal act, not a moderator one: no permission is needed, it works
    -- against somebody who outranks you, and nobody but the blocker ever sees
    -- a row. The bans table is the moderator's and this is deliberately
    -- separate from it.
    --
    -- Keyed on gryt_user_id on both sides, the same as bans. A block keyed on
    -- server_user_id would last only until the blocked person rejoined with a
    -- fresh local identity, which is one tap. Every row in users has both
    -- columns and both are NOT NULL UNIQUE, local identities included, so this
    -- costs nothing to look up.
    --
    -- No reason column. The list is read by one person about people they can
    -- already see, and a reason field is somewhere for the blocker to write
    -- something the blocked person must never read.
    CREATE TABLE IF NOT EXISTS blocks (
      blocker_gryt_user_id TEXT NOT NULL,
      blocked_gryt_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocker_gryt_user_id, blocked_gryt_user_id)
    );
    -- Delivery asks who has blocked this sender on every message, which is the
    -- opposite direction from the one the primary key serves.
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_gryt_user_id);

    CREATE TABLE IF NOT EXISTS join_requests (
      gryt_user_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by_server_user_id TEXT
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
      -- How a text channel is presented (chat stream vs forum of topics) and
      -- whether only bots/webhooks/system may post. GRYT-981 / GRYT-982.
      layout TEXT NOT NULL DEFAULT 'chat',
      automated INTEGER NOT NULL DEFAULT 0,
      forum_tags TEXT,
      -- Both of these are migrated into channel_permission_scopes on upgrade
      -- and nothing reads them afterwards. They stay so that a server rolled
      -- back to an older build still enforces the gate it had, which a dropped
      -- column would lose silently. migrateRankGatesToScopes in
      -- migrations/rankGates.ts is the one-way door, and schema_meta records
      -- that it has run.
      post_min_rank INTEGER,
      view_min_rank INTEGER,
      -- Which permission scope decides what each role may do here.
      --
      -- NULL means the channel has no opinion: every role gets exactly what its
      -- server-wide definition gives it. That is every channel until somebody
      -- narrows one, so the common case stores nothing and costs nothing.
      permission_scope_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- A named set of per-role rules, shared by every channel that points at it.
    --
    -- Templates are the reason this is its own table rather than columns on
    -- channels. Discord puts the overwrites on the channel, which works until
    -- you have forty channels that were meant to match: there is then no way to
    -- change them together, and they drift apart one edit at a time. A scope
    -- that several channels share can be edited once.
    --
    -- "Custom" is not a special case. Choosing it makes a private scope owned by
    -- that one channel: is_template 0, no name. So there is exactly one
    -- lookup path and no branch anywhere that resolves a permission.
    CREATE TABLE IF NOT EXISTS channel_permission_scopes (
      scope_id TEXT PRIMARY KEY,
      -- NULL for a channel's private scope. Templates are the named ones, and
      -- they are the only ones the settings UI lists.
      name TEXT,
      is_template INTEGER NOT NULL DEFAULT 0,
      -- A template the server ships and will not let you delete.
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- One row per thing a scope actually changes.
    --
    -- Absence is "inherit", which is why there is no row for it. A scope that
    -- hides a channel from three roles is three rows, not thirteen permissions
    -- times five roles — and a permission added to the catalogue later needs no
    -- backfill, because every scope already inherits it.
    --
    -- effect is 'allow' or 'deny'. Allow is not redundant with inheriting: it
    -- grants a permission the role does not hold server-wide, which is how one
    -- channel lets a role post when it may not post anywhere else.
    CREATE TABLE IF NOT EXISTS channel_permission_rules (
      scope_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      effect TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, role_id, permission)
    );

    CREATE TABLE IF NOT EXISTS sidebar_items (
      item_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'channel',
      position INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT,
      spacer_height INTEGER,
      label TEXT,
      parent_item_id TEXT,
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
      thread_id TEXT,
      edited_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, created_at);
    -- How many messages one person has sent, which is half of what an
    -- automatic promotion is measured on. Without it that count is a full scan
    -- of the table on every message anybody sends.
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_server_id);
    -- A thread hangs off one root message in a conversation. The root stays in
    -- the timeline; the replies carry messages.thread_id and are kept out of it.
    -- root_message_id is unique: a message roots at most one thread. GRYT-981.
    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      root_message_id TEXT NOT NULL,
      title TEXT,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reply_count INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      tags TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_root ON threads(root_message_id);
    CREATE INDEX IF NOT EXISTS idx_threads_conv ON threads(conversation_id, last_message_at);

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'dm',
      name TEXT,
      icon_file_id TEXT,
      created_by_server_user_id TEXT,
      created_at TEXT NOT NULL,
      last_message_at TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      server_user_id TEXT NOT NULL,
      hidden_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, server_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(server_user_id);

    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      s3_key TEXT NOT NULL,
      mime TEXT,
      size INTEGER,
      width INTEGER,
      height INTEGER,
      thumbnail_key TEXT,
      thumbnail_px INTEGER,
      original_name TEXT,
      dominant_color TEXT,
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

    -- Who a message named, resolved to ids when it was sent.
    --
    -- Stored rather than derived, for two reasons. Working it out on read means
    -- re-parsing every message in every channel to answer "have I been
    -- mentioned", which is the question asked most often and by every client on
    -- connect. And it means parsing against *today's* nicknames: somebody who
    -- renames themselves would collect mentions they never received, and lose
    -- the ones they did.
    --
    -- The row is the fact that it happened. seen_at is the only part that
    -- changes, and it is per mention rather than per channel because a channel
    -- being read does not mean the question aimed at you in it was answered.
    CREATE TABLE IF NOT EXISTS mentions (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      server_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen_at TEXT,
      PRIMARY KEY (message_id, server_user_id),
      -- The one foreign key in the schema, and it earns its place: a mention of
      -- a deleted message is a badge that scrolls to a gap. Messages are
      -- deleted from four places -- the delete handler, the empty-attachment
      -- prune, a ban with content purge, and deleting a conversation -- and
      -- the fifth one written later would be the one that forgot. Composite
      -- because that is the messages primary key.
      FOREIGN KEY (conversation_id, message_id)
        REFERENCES messages(conversation_id, message_id) ON DELETE CASCADE
    );
    -- The only question this table is asked: what has this person not seen.
    -- Partial, because the rows already seen are the ones nobody comes back for
    -- and they are most of the table within a day.
    CREATE INDEX IF NOT EXISTS idx_mentions_unseen
      ON mentions(server_user_id, created_at) WHERE seen_at IS NULL;

    -- A report about a person rather than about one message.
    --
    -- Its own table rather than a nullable message_id on reports, because the
    -- two are aggregated differently: the message queue groups by message and
    -- counts reporters, this one groups by the person reported. Sharing a
    -- table would have meant every query in either path filtering on a kind
    -- column it did not otherwise care about.
    --
    -- reason is required. A message report needs none, because the message is
    -- the evidence. A report about a person with nothing attached says only
    -- that somebody is unhappy, and a moderator cannot act on that.
    --
    -- Both nicknames are snapshots, for the same reason the message queue
    -- snapshots the sender's: the row has to stay readable after they leave.
    -- The reporter's is snapshotted too, which the message queue does not do —
    -- somebody reported for harassment is often banned, and the person who
    -- reported them often leaves. Resolving the name at read time then puts a
    -- raw user id where the card says who this came from.
    CREATE TABLE IF NOT EXISTS user_reports (
      report_id TEXT PRIMARY KEY,
      reported_server_user_id TEXT NOT NULL,
      reported_nickname TEXT,
      reporter_server_user_id TEXT NOT NULL,
      reporter_nickname TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by_server_user_id TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status, created_at);

    CREATE TABLE IF NOT EXISTS webhooks (
      webhook_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT 'Webhook',
      avatar_file_id TEXT,
      created_by_server_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);

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

function hasColumn(d: DatabaseSync, table: string, column: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

function runMigrations(d: DatabaseSync): void {
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

  // Additive with a constant default, so existing tokens still match. No index:
  // one would have to be built after this column, and createSchema runs first.
  if (!hasColumn(d, "users", "token_version")) {
    d.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasColumn(d, "channels", "post_min_rank")) {
    d.exec("ALTER TABLE channels ADD COLUMN post_min_rank INTEGER");
  }

  // NULL on every existing row, or a migration guessing a threshold hides
  // channels people were already using.
  if (!hasColumn(d, "channels", "view_min_rank")) {
    d.exec("ALTER TABLE channels ADD COLUMN view_min_rank INTEGER");
  }

  if (!hasColumn(d, "channels", "permission_scope_id")) {
    d.exec("ALTER TABLE channels ADD COLUMN permission_scope_id TEXT");
  }

  // NULL is the top level, so an upgrade leaves the sidebar exactly as it was.
  if (!hasColumn(d, "sidebar_items", "parent_item_id")) {
    d.exec("ALTER TABLE sidebar_items ADD COLUMN parent_item_id TEXT");
  }

  // Older databases predate both tables. CREATE TABLE IF NOT EXISTS above only
  // runs against a fresh file, so upgrading needs them here as well.
  d.exec(`
    CREATE TABLE IF NOT EXISTS channel_permission_scopes (
      scope_id TEXT PRIMARY KEY,
      name TEXT,
      is_template INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_permission_rules (
      scope_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      effect TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, role_id, permission)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_permission_rules_scope
      ON channel_permission_rules (scope_id);
  `);

  // Off until somebody ticks it: rank alone makes every role below the creator
  // silently grantable the moment it exists.
  if (!hasColumn(d, "role_definitions", "grantable_by_invite")) {
    d.exec("ALTER TABLE role_definitions ADD COLUMN grantable_by_invite INTEGER NOT NULL DEFAULT 0");
  }

  // The snapshot is the whole defence against the role being edited upward:
  // without it the link hands out whatever it grew into.
  if (!hasColumn(d, "invites", "granted_role_id")) {
    d.exec("ALTER TABLE invites ADD COLUMN granted_role_id TEXT");
  }
  if (!hasColumn(d, "invites", "granted_role_rank")) {
    d.exec("ALTER TABLE invites ADD COLUMN granted_role_rank INTEGER");
  }

  if (!hasColumn(d, "server_config", "lan_open")) {
    d.exec("ALTER TABLE server_config ADD COLUMN lan_open INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasColumn(d, "server_config", "discoverable")) {
    d.exec("ALTER TABLE server_config ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 1");
  }

  // Not derived from JWT_SECRET, so rotating that does not take voice down, and
  // deliberately not on ServerConfigRecord, which names its fields one by one.
  if (!hasColumn(d, "server_config", "sfu_secret")) {
    d.exec("ALTER TABLE server_config ADD COLUMN sfu_secret TEXT");
  }

  // Text rather than a boolean, because the third answer is holding somebody for
  // a moderator and two flags can disagree. Then a rename count, not the names.
  if (!hasColumn(d, "users", "nickname_change_count")) {
    d.exec("ALTER TABLE users ADD COLUMN nickname_change_count INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasColumn(d, "users", "nickname_changed_at")) {
    d.exec("ALTER TABLE users ADD COLUMN nickname_changed_at TEXT");
  }

  if (!hasColumn(d, "server_config", "join_policy")) {
    d.exec("ALTER TABLE server_config ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'invite'");
  }

  // Written by the image worker, which already decodes every upload. Null where
  // it could not read one, and consumers fall back rather than backfilling.
  if (!hasColumn(d, "files", "dominant_color")) {
    d.exec("ALTER TABLE files ADD COLUMN dominant_color TEXT");
  }

  // So a consumer can tell whether a thumbnail is still the size we would write.
  // Null is "unknown, rebuild it" to the image worker.
  if (!hasColumn(d, "files", "thumbnail_px")) {
    d.exec("ALTER TABLE files ADD COLUMN thumbnail_px INTEGER");
  }

  // Published for the image worker, which shares no package with this one, and
  // written every start so it tracks the constant rather than the row's age.
  if (!hasColumn(d, "server_config", "avatar_thumb_px")) {
    d.exec("ALTER TABLE server_config ADD COLUMN avatar_thumb_px INTEGER");
  }

  // NULL is permanent, as in invites.expires_at. Nullable because there is no
  // sensible constant default, and every ban predating this column is permanent.
  if (!hasColumn(d, "bans", "expires_at")) {
    d.exec("ALTER TABLE bans ADD COLUMN expires_at TEXT");
  }

  // Mute and deafen belong to the user, not the connection, which reset them on
  // reconnect. A constant default is legal on ADD COLUMN, so no backfill.
  if (!hasColumn(d, "users", "is_server_muted")) {
    d.exec("ALTER TABLE users ADD COLUMN is_server_muted INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(d, "users", "is_server_deafened")) {
    d.exec("ALTER TABLE users ADD COLUMN is_server_deafened INTEGER NOT NULL DEFAULT 0");
  }

  // Same shape as a temporary ban: NULL means until somebody removes it, and it
  // is evaluated on read rather than swept.
  if (!hasColumn(d, "users", "server_mute_expires_at")) {
    d.exec("ALTER TABLE users ADD COLUMN server_mute_expires_at TEXT");
  }
  // Both start at 'member', the role everybody used to get, so these appearing
  // changes nothing until somebody edits them.
  if (!hasColumn(d, "server_config", "default_role_account")) {
    d.exec("ALTER TABLE server_config ADD COLUMN default_role_account TEXT NOT NULL DEFAULT 'member'");
  }
  if (!hasColumn(d, "server_config", "default_role_local")) {
    d.exec("ALTER TABLE server_config ADD COLUMN default_role_local TEXT NOT NULL DEFAULT 'member'");
  }

  // NULL means that half is not asked, and both NULL is never granted
  // automatically — which is every role that existed before this.
  if (!hasColumn(d, "role_definitions", "auto_grant_after_days")) {
    d.exec("ALTER TABLE role_definitions ADD COLUMN auto_grant_after_days INTEGER");
  }
  if (!hasColumn(d, "role_definitions", "auto_grant_after_messages")) {
    d.exec("ALTER TABLE role_definitions ADD COLUMN auto_grant_after_messages INTEGER");
  }

  // `request` writes one pending row per bot identity and admits nothing, so the
  // default widens only a rate-limited row in a table that grants nothing.
  if (!hasColumn(d, "server_config", "bot_join_policy")) {
    d.exec("ALTER TABLE server_config ADD COLUMN bot_join_policy TEXT NOT NULL DEFAULT 'request'");
  }

  // Null is no designed look, which is not the string for a look with every slot
  // empty — that one draws differently. Never parsed here.
  if (!hasColumn(d, "users", "avatar_worn")) {
    d.exec("ALTER TABLE users ADD COLUMN avatar_worn TEXT");
  }

  // Off stops conversations being opened or posted in and keeps the rows. The
  // name is groups only: a copy of a person's name would go stale.
  if (!hasColumn(d, "conversations", "name")) {
    d.exec("ALTER TABLE conversations ADD COLUMN name TEXT");
  }

  // Uploads only. A group without one is drawn from its name by the clients, so
  // the generated icon follows a rename rather than being stored.
  if (!hasColumn(d, "conversations", "icon_file_id")) {
    d.exec("ALTER TABLE conversations ADD COLUMN icon_file_id TEXT");
  }

  // On the membership row, since it is one person's answer. Nothing is deleted,
  // and a new message brings it back.
  if (!hasColumn(d, "conversation_members", "hidden_at")) {
    d.exec("ALTER TABLE conversation_members ADD COLUMN hidden_at TEXT");
  }

  if (!hasColumn(d, "server_config", "allow_dms")) {
    d.exec("ALTER TABLE server_config ADD COLUMN allow_dms INTEGER NOT NULL DEFAULT 1");
  }

  // Stored and handed back whole, and never read here. One column rather than a
  // key beside a signature, so the two cannot be mixed between members.
  if (!hasColumn(d, "users", "dm_key_binding")) {
    d.exec("ALTER TABLE users ADD COLUMN dm_key_binding TEXT");
  }

  // The whole envelope, untouched. With it set `text` is null and there is
  // nothing to filter or moderate, so a channel cannot hold one.
  if (!hasColumn(d, "messages", "sealed")) {
    d.exec("ALTER TABLE messages ADD COLUMN sealed TEXT");
  }

  // Null for a normal message. The threads table itself is created by
  // createSchema, which runs IF NOT EXISTS on every boot.
  if (!hasColumn(d, "messages", "thread_id")) {
    d.exec("ALTER TABLE messages ADD COLUMN thread_id TEXT");
  }

  // Here rather than createSchema, which runs first: beside the other message
  // indexes it threw `no such column`, aborting the schema on every upgrade.
  d.exec("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)");

  // Existing channels default to a normal chat everyone can post in.
  if (!hasColumn(d, "channels", "layout")) {
    d.exec("ALTER TABLE channels ADD COLUMN layout TEXT NOT NULL DEFAULT 'chat'");
  }
  if (!hasColumn(d, "channels", "automated")) {
    d.exec("ALTER TABLE channels ADD COLUMN automated INTEGER NOT NULL DEFAULT 0");
  }

  // A forum channel's tag palette, and the tag ids a topic carries. Both JSON,
  // additive, defaulting to none. GRYT-981 Stage 3.
  if (!hasColumn(d, "channels", "forum_tags")) {
    d.exec("ALTER TABLE channels ADD COLUMN forum_tags TEXT");
  }
  if (!hasColumn(d, "threads", "tags")) {
    d.exec("ALTER TABLE threads ADD COLUMN tags TEXT");
  }

  d.prepare("UPDATE server_config SET avatar_thumb_px = ?").run(AVATAR_THUMB_PX);

  // Before the built-in roles are seeded, because seeding writes rows through
  // the normal path and the table has to be the right shape first.
  migrateRolesToMultiple(d);

  seedBuiltInRoles(d);
  backfillRolePermissions(d);

  // After the roles, whose ranks it reads, and before anything serves a request,
  // or a gated channel is open to everybody in between.
  migrateRankGatesToScopes(d);
}

/**
 * SQLite cannot widen a primary key in place, so this is the standard rebuild.
 * A rollback leaves the wider table and an old build's inserts fail loudly.
 */
function migrateRolesToMultiple(d: DatabaseSync): void {
  const cols = d.prepare("PRAGMA table_info(roles)").all() as unknown as {
    name: string;
    pk: number;
  }[];
  if (cols.length === 0) return; // No table yet; createSchema made the new one.

  const keyed = cols.filter((c) => c.pk > 0).map((c) => c.name);
  if (keyed.includes("role")) return; // Already been through this.

  d.exec("BEGIN");
  try {
    d.exec(`
      CREATE TABLE roles_multi (
        server_user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (server_user_id, role)
      );
      INSERT INTO roles_multi (server_user_id, role, created_at, updated_at)
        SELECT server_user_id, role, created_at, updated_at FROM roles;
      DROP TABLE roles;
      ALTER TABLE roles_multi RENAME TO roles;
      CREATE INDEX IF NOT EXISTS idx_roles_role ON roles(role);
    `);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

function readSchemaMeta(d: DatabaseSync, key: string): string | null {
  const row = d.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSchemaMeta(d: DatabaseSync, key: string, value: string): void {
  d.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
  ).run(key, value, value);
}

const PERMISSION_SCHEMA_KEY = "permission_schema_version";

/**
 * A build that adds a permission changes no stored role, and the seeder cannot
 * fix that without overwriting an operator's choices. Grants only.
 */
function backfillRolePermissions(d: DatabaseSync): void {
  const stamped = Number(readSchemaMeta(d, PERMISSION_SCHEMA_KEY) ?? 0);
  if (stamped >= PERMISSION_SCHEMA_VERSION) return;

  const rows = d
    .prepare(`SELECT role_id, permissions FROM role_definitions`)
    .all() as { role_id: string; permissions: string }[];

  const update = d.prepare(
    `UPDATE role_definitions SET permissions = ?, updated_at = ? WHERE role_id = ?`,
  );
  const now = new Date().toISOString();
  let changed = 0;

  for (const row of rows) {
    let held: string[];
    try {
      const parsed = JSON.parse(row.permissions);
      held = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch {
      // An unparseable column reads as no permissions, so the backfill grants the
      // ungated set — the closest thing to what the role could do before.
      held = [];
    }

    const gained = backfillFor(held, stamped);
    if (gained.length === 0) continue;

    update.run(JSON.stringify([...held, ...gained]), now, row.role_id);
    changed += 1;
  }

  if (changed > 0) {
    console.log(
      `[permissions] backfilled ${changed} role(s) from schema v${stamped} to v${PERMISSION_SCHEMA_VERSION}`,
    );
  }
  writeSchemaMeta(d, PERMISSION_SCHEMA_KEY, String(PERMISSION_SCHEMA_VERSION));
}

/** INSERT OR IGNORE, never a replace: these rows are editable, so a deleted one
    comes back without touching what an operator chose. */
function seedBuiltInRoles(d: DatabaseSync): void {
  const now = new Date().toISOString();
  const insert = d.prepare(
    `INSERT OR IGNORE INTO role_definitions (role_id, name, color, rank, permissions, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const markSystem = d.prepare(`UPDATE role_definitions SET is_system = 1 WHERE role_id = ?`);

  for (const role of BUILT_IN_ROLES) {
    insert.run(
      role.id,
      role.name,
      role.color,
      role.rank,
      JSON.stringify(role.permissions),
      now,
      now,
    );
    markSystem.run(role.id);
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
