import { existsSync, mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "path";

import { AVATAR_THUMB_PX } from "../../constants/media";
import {
  backfillFor,
  BUILT_IN_ROLES,
  PERMISSION_SCHEMA_VERSION,
} from "../../constants/permissions";

/**
 * Re-exported so the query modules can type their dynamic parameter arrays
 * without importing the driver themselves. This file is the only one that knows
 * which driver is in use, and it is worth keeping it that way — the move off
 * better-sqlite3 touched one import because of it.
 */
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

  // node:sqlite has no pragma() helper, so these go through exec(). Same
  // statements as before, in the same order — and the order matters: WAL is
  // what lets the image worker write to this file from its own process while
  // the server holds it open.
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
      -- Minimum rank required to post here. NULL means anybody who holds
      -- send_messages, which is every channel until somebody says otherwise.
      -- A rank rather than a list of roles because ranks are already ordered
      -- and already decide who may act on whom, so "staff only" is one number
      -- and stays correct when a role is added between two others.
      post_min_rank INTEGER,
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
    -- How many messages one person has sent, which is half of what an
    -- automatic promotion is measured on. Without it that count is a full scan
    -- of the table on every message anybody sends.
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_server_id);

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

  if (!hasColumn(d, "channels", "post_min_rank")) {
    d.exec("ALTER TABLE channels ADD COLUMN post_min_rank INTEGER");
  }

  if (!hasColumn(d, "server_config", "lan_open")) {
    d.exec("ALTER TABLE server_config ADD COLUMN lan_open INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasColumn(d, "server_config", "discoverable")) {
    d.exec("ALTER TABLE server_config ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 1");
  }

  // Whether somebody who is not already a member needs an invite. Text rather
  // than a boolean because the third answer — hold them until a moderator says
  // yes — is the one a busy public server actually wants, and adding it as a
  // second flag later would leave two columns that can disagree.
  //
  // Defaults to 'invite', which is what every server did before the column
  // existed.
  // How often somebody has renamed themselves here, and when they last did.
  //
  // A count and a timestamp rather than the old names. What answers "is this
  // the person I think it is" is that the account became this name an hour ago,
  // not what it used to be called — and past names are the part somebody may
  // have had a good reason to leave behind. Anything that wants the names
  // themselves should be gated on a role and is not this.
  //
  // Existing rows start at zero, which reads as "never renamed". That is wrong
  // for anyone who has, and there is nothing to backfill from; a count that
  // only starts now is worth more than no count at all.
  if (!hasColumn(d, "users", "nickname_change_count")) {
    d.exec("ALTER TABLE users ADD COLUMN nickname_change_count INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasColumn(d, "users", "nickname_changed_at")) {
    d.exec("ALTER TABLE users ADD COLUMN nickname_changed_at TEXT");
  }

  if (!hasColumn(d, "server_config", "join_policy")) {
    d.exec("ALTER TABLE server_config ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'invite'");
  }

  // The dominant colour of an uploaded image, as #rrggbb. Written by the image
  // worker, which already decodes every upload to build a thumbnail. Null for
  // everything uploaded before this column existed and for images the worker
  // could not read — consumers fall back rather than backfilling.
  if (!hasColumn(d, "files", "dominant_color")) {
    d.exec("ALTER TABLE files ADD COLUMN dominant_color TEXT");
  }

  // How big a thumbnail actually is, so a consumer can tell whether it is still
  // the size we would write today. Null for everything made before this column,
  // which the image worker treats as "unknown, rebuild it".
  if (!hasColumn(d, "files", "thumbnail_px")) {
    d.exec("ALTER TABLE files ADD COLUMN thumbnail_px INTEGER");
  }

  // The avatar thumbnail size this server writes, published for the image
  // worker. It runs from a separate repository with no package shared with this
  // one, and the alternative was the same constant written down in both and
  // kept in step by hand — where a disagreement makes the worker's rebuild pass
  // either run forever or never. Written on every start so it tracks the
  // constant rather than whatever was true when the row was created.
  if (!hasColumn(d, "server_config", "avatar_thumb_px")) {
    d.exec("ALTER TABLE server_config ADD COLUMN avatar_thumb_px INTEGER");
  }

  // When a ban lifts by itself, as ISO-8601. NULL means permanent, matching
  // what NULL already means in invites.expires_at and refresh_tokens.expires_at.
  //
  // Nullable rather than NOT NULL because SQLite cannot add a NOT NULL column
  // without a constant default, and there is no sensible constant here — every
  // ban that predates this column is permanent, which is exactly NULL.
  if (!hasColumn(d, "bans", "expires_at")) {
    d.exec("ALTER TABLE bans ADD COLUMN expires_at TEXT");
  }

  // Server mute and deafen used to live only on the socket, and were reset to
  // false on every connection — so reconnecting, or opening a second tab,
  // cleared them. They belong to the user rather than to the connection.
  //
  // NOT NULL with a constant default is legal on ADD COLUMN, unlike a
  // non-constant one, so these need no backfill: everyone starts unmuted.
  if (!hasColumn(d, "users", "is_server_muted")) {
    d.exec("ALTER TABLE users ADD COLUMN is_server_muted INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(d, "users", "is_server_deafened")) {
    d.exec("ALTER TABLE users ADD COLUMN is_server_deafened INTEGER NOT NULL DEFAULT 0");
  }

  // A timeout is a mute that lifts by itself. Same shape as a temporary ban:
  // nullable ISO-8601, NULL meaning "until somebody removes it", evaluated on
  // read rather than swept by a job.
  if (!hasColumn(d, "users", "server_mute_expires_at")) {
    d.exec("ALTER TABLE users ADD COLUMN server_mute_expires_at TEXT");
  }
  // Which role a first-time joiner gets, split by identity tier. Both start at
  // 'member' — the role everybody used to be given — so the columns appearing
  // changes nothing until somebody edits them.
  if (!hasColumn(d, "server_config", "default_role_account")) {
    d.exec("ALTER TABLE server_config ADD COLUMN default_role_account TEXT NOT NULL DEFAULT 'member'");
  }
  if (!hasColumn(d, "server_config", "default_role_local")) {
    d.exec("ALTER TABLE server_config ADD COLUMN default_role_local TEXT NOT NULL DEFAULT 'member'");
  }

  // What a role asks of somebody before it grants itself. NULL means that half
  // of the condition is not being asked, and a role with both NULL is never
  // granted automatically — which is every role that existed before this.
  if (!hasColumn(d, "role_definitions", "auto_grant_after_days")) {
    d.exec("ALTER TABLE role_definitions ADD COLUMN auto_grant_after_days INTEGER");
  }
  if (!hasColumn(d, "role_definitions", "auto_grant_after_messages")) {
    d.exec("ALTER TABLE role_definitions ADD COLUMN auto_grant_after_messages INTEGER");
  }

  // Whether a bot nobody has heard of may leave a knock at the door.
  //
  // `request` writes one pending row per bot identity and admits nothing; an
  // operator still has to approve it. `disabled` refuses outright, for a server
  // that only ever wants bots it set up itself with a claim token.
  //
  // Defaults to `request` rather than `disabled`, which is the one place this
  // change widens anything. What it widens is a rate-limited row in a table that
  // grants nothing — the same shape as a join request, which is already how a
  // stranger asks to be let in.
  if (!hasColumn(d, "server_config", "bot_join_policy")) {
    d.exec("ALTER TABLE server_config ADD COLUMN bot_join_policy TEXT NOT NULL DEFAULT 'request'");
  }

  // What somebody's owl is wearing, as the short string `@gryt/owl` encodes.
  //
  // The avatar it describes is drawn on the client, every time, at the size it
  // is shown. That is the difference from `avatar_file_id`, which is a picture
  // somebody uploaded: a designed owl kept as a PNG stops following palette
  // changes and never gets sharper than the raster it was saved at.
  //
  // Null means there is no designed look — every row that predates this, and
  // everybody who uploaded a picture instead. That is not the same as the string
  // for a look with every slot empty, which is somebody who took everything off
  // and draws differently from the owl their seed would have picked.
  //
  // Never parsed here. See `utils/wornString.ts` for why the server checks the
  // shape and stops there.
  if (!hasColumn(d, "users", "avatar_worn")) {
    d.exec("ALTER TABLE users ADD COLUMN avatar_worn TEXT");
  }

  // Whether members can open direct messages with each other here.
  //
  // A server that stores DMs is storing private messages between two of its
  // members on behalf of both, and an operator who did not sign up for that
  // needs a way to say no. Off means no conversation can be opened and no
  // message can be sent to one that already exists; the rows stay, because
  // turning the setting back on should not have thrown away history.
  //
  // Defaults to on, which matches every other feature arriving switched on,
  // and an operator who wants it off can say so before inviting anybody.
  // What a group is called, when somebody has named it.
  //
  // Only groups. A one-to-one conversation is named after the person you are
  // talking to, which is not a string this table should be holding: it changes
  // when they rename themselves, and a copy here would go stale. NULL on a
  // group means the clients build a name from who is in it.
  if (!hasColumn(d, "conversations", "name")) {
    d.exec("ALTER TABLE conversations ADD COLUMN name TEXT");
  }

  // A picture somebody uploaded for a group.
  //
  // Only an upload. A group with none is drawn from its name, by the clients,
  // the same way a server with no icon is — so the generated one follows a
  // rename instead of being a file that has to be regenerated and stored.
  if (!hasColumn(d, "conversations", "icon_file_id")) {
    d.exec("ALTER TABLE conversations ADD COLUMN icon_file_id TEXT");
  }

  // When somebody took this conversation out of their own sidebar.
  //
  // On the membership row rather than the conversation, because it is one
  // person's answer: hiding a conversation says nothing about whether the
  // other party wants it in theirs. NULL means visible, which is what every
  // row written before this column existed meant.
  //
  // Nothing is deleted. The messages stay, and the conversation comes back on
  // its own when a new one arrives — see `clearConversationHidden`.
  if (!hasColumn(d, "conversation_members", "hidden_at")) {
    d.exec("ALTER TABLE conversation_members ADD COLUMN hidden_at TEXT");
  }

  if (!hasColumn(d, "server_config", "allow_dms")) {
    d.exec("ALTER TABLE server_config ADD COLUMN allow_dms INTEGER NOT NULL DEFAULT 1");
  }

  // What a member says their DM public key is (GRYT-720).
  //
  // A compact JWT the client signs with the identity key it joined on, carrying
  // its X25519 public key. Stored whole and handed back whole. Nothing here
  // reads it, and that is the design rather than a shortcut: the point of the
  // feature is that this server cannot read the messages, and a server that
  // verified the binding would be asserting something a client must check for
  // itself anyway. Members pin what they are given and refuse a change.
  //
  // One column rather than a key and a signature side by side, so there is no
  // way to hand out one member's key with another's signature.
  //
  // NULL for everybody who has not sent one, which is every row written before
  // this and every client older than the feature. No DM key means no encrypted
  // message, which is what happens today.
  if (!hasColumn(d, "users", "dm_key_binding")) {
    d.exec("ALTER TABLE users ADD COLUMN dm_key_binding TEXT");
  }

  // A message this server cannot read (GRYT-729).
  //
  // The whole sealed envelope, stored and handed back untouched. When it is set
  // `text` is null and there is nothing here to filter, search, moderate or
  // export — which is the feature rather than a regression, and is why the
  // handler refuses one on a channel: a channel is a room with a member list,
  // not a pair of people, and there is no key to seal to.
  //
  // Null for every message written before this and every one sent in the clear.
  // A conversation is a mix of both for as long as it takes everybody to
  // update, and each message says which it was.
  if (!hasColumn(d, "messages", "sealed")) {
    d.exec("ALTER TABLE messages ADD COLUMN sealed TEXT");
  }

  d.prepare("UPDATE server_config SET avatar_thumb_px = ?").run(AVATAR_THUMB_PX);

  seedBuiltInRoles(d);
  backfillRolePermissions(d);
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
 * Give existing roles the permissions that did not exist when they were
 * written.
 *
 * A role is a stored list of permission strings, so a build that adds a
 * permission changes no row — and on the release that made reading a
 * permission, every role on every existing server would have become a role that
 * cannot read. The seeder cannot fix that: it only inserts roles that are
 * missing, and it must never overwrite permissions an operator chose.
 *
 * So each new permission names the one it was carved out of, and whoever holds
 * that keeps doing what they were already doing. Grants only, never removals,
 * and stamped so it runs once — though `backfillFor` skips what a role already
 * has, so running it twice would change nothing either.
 *
 * A brand-new database gets stamped at the current version after the seeder has
 * already written the right sets, so this is a no-op there.
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
      // A column that will not parse reads as no permissions, same as
      // everywhere else. The backfill then grants it the ungated set, which is
      // the closest thing to what the role could actually do before.
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

/**
 * Write the five roles that ship with the server, if they are missing.
 *
 * INSERT OR IGNORE rather than a replace: these rows are editable, and running
 * this on every start is what makes a role somebody deleted by hand come back —
 * but only the row, never the permissions an operator chose. A build that adds
 * a sixth built-in gets it on the next start without a version stamp to
 * maintain.
 *
 * The one thing that is rewritten every start is `is_system`, because that flag
 * is this file's opinion and not the operator's: a build that promotes a role
 * to built-in has to be able to say so.
 */
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
