import { Client, auth } from "cassandra-driver";

let client: Client | null = null;

export function getScyllaClient(): Client {
  if (!client) throw new Error("Scylla client not initialized. Call initScylla() first.");
  return client;
}

export async function initScylla(): Promise<void> {
  const contactPoints = (process.env.SCYLLA_CONTACT_POINTS || "127.0.0.1").split(",").map((s) => s.trim());
  const localDataCenter = process.env.SCYLLA_LOCAL_DATACENTER || "datacenter1";
  const keyspace = process.env.SCYLLA_KEYSPACE || "gryt";

  const username = process.env.SCYLLA_USERNAME;
  const password = process.env.SCYLLA_PASSWORD;

  const commonConfig: any = {
    contactPoints,
    localDataCenter,
    ...(username && password
      ? { authProvider: new auth.PlainTextAuthProvider(username, password) }
      : {}),
  };

  // temp client without keyspace to create it if missing
  const temp = new Client(commonConfig);
  await temp.connect();
  await temp.execute(
    `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`
  );
  await temp.shutdown();

  // main client using keyspace
  client = new Client({ ...commonConfig, keyspace });
  await client.connect();

  // Server-scoped config (ONE server per keyspace).
  // We store a single row keyed by id="config".
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_config_singleton (
      id text PRIMARY KEY,
      owner_gryt_user_id text,
      token_version int,
      display_name text,
      description text,
      icon_url text,
      password_salt text,
      password_hash text,
      password_algo text,
      avatar_max_bytes bigint,
      upload_max_bytes bigint,
      voice_max_bitrate_bps int,
      is_configured boolean,
      created_at timestamp,
      updated_at timestamp
    )`
  );

  // Add server config columns (best-effort for existing tables)
  const addCfgCol = async (colDef: string) => {
    try {
      const c = getScyllaClient();
      await c.execute(`ALTER TABLE server_config_singleton ADD ${colDef}`);
    } catch (error: any) {
      if (!error?.message?.includes("already exists") && !error?.message?.includes("Invalid column name")) {
        console.warn(`Warning: Could not add ${colDef} to server_config_singleton:`, error.message);
      }
    }
  };
  await addCfgCol("avatar_max_bytes bigint");
  await addCfgCol("upload_max_bytes bigint");
  await addCfgCol("voice_max_bitrate_bps int");

  // Invites (ONE server per keyspace; code uniqueness per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_invites_by_code (
      code text PRIMARY KEY,
      created_at timestamp,
      created_by_server_user_id text,
      expires_at timestamp,
      max_uses int,
      uses_remaining int,
      revoked boolean,
      note text
    )`
  );

  // Roles (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_roles_by_user (
      server_user_id text PRIMARY KEY,
      role text,
      created_at timestamp,
      updated_at timestamp
    )`
  );

  // Bans (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_bans_by_gryt_id (
      gryt_user_id text PRIMARY KEY,
      banned_by_server_user_id text,
      reason text,
      created_at timestamp
    )`
  );

  // Channels (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_channels_by_id (
      channel_id text PRIMARY KEY,
      name text,
      type text,
      position int,
      description text,
      created_at timestamp,
      updated_at timestamp
    )`
  );

  // Channel settings columns (idempotent ALTER TABLE for existing deployments)
  for (const col of [
    "require_push_to_talk boolean",
    "disable_rnnoise boolean",
    "max_bitrate int",
    "esports_mode boolean",
  ]) {
    await client.execute(`ALTER TABLE server_channels_by_id ADD ${col}`).catch(() => {});
  }

  // Sidebar items (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_sidebar_items_by_id (
      item_id text PRIMARY KEY,
      kind text,
      position int,
      channel_id text,
      spacer_height int,
      label text,
      created_at timestamp,
      updated_at timestamp
    )`
  );

  // Audit log (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_audit_by_id (
      bucket text,
      created_at timestamp,
      event_id uuid,
      actor_server_user_id text,
      action text,
      target text,
      meta_json text,
      PRIMARY KEY ((bucket), created_at, event_id)
    ) WITH CLUSTERING ORDER BY (created_at DESC, event_id DESC)`
  );

  // Users (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS users_by_gryt_id (
      gryt_user_id text PRIMARY KEY,
      server_user_id text,
      nickname text,
      created_at timestamp,
      last_seen timestamp,
      is_active boolean
    )`
  );

  await client.execute(
    `CREATE TABLE IF NOT EXISTS users_by_server_id (
      server_user_id text PRIMARY KEY,
      gryt_user_id text,
      nickname text,
      created_at timestamp,
      last_seen timestamp,
      is_active boolean
    )`
  );

  // Add is_active column to existing tables if it doesn't exist
  try {
    await client.execute(`ALTER TABLE users_by_gryt_id ADD is_active boolean`);
    console.log('✅ Added is_active column to users_by_gryt_id table');
  } catch (error: any) {
    if (error.message.includes('already exists') || error.message.includes('Invalid column name')) {
      console.log('ℹ️ is_active column already exists in users_by_gryt_id table');
    } else {
      console.error('❌ Failed to add is_active column to users_by_gryt_id:', error.message);
    }
  }

  try {
    await client.execute(`ALTER TABLE users_by_server_id ADD is_active boolean`);
    console.log('✅ Added is_active column to users_by_server_id table');
  } catch (error: any) {
    if (error.message.includes('already exists') || error.message.includes('Invalid column name')) {
      console.log('ℹ️ is_active column already exists in users_by_server_id table');
    } else {
      console.error('❌ Failed to add is_active column to users_by_server_id:', error.message);
    }
  }

  // Add avatar_file_id column to user tables
  try {
    await client.execute(`ALTER TABLE users_by_gryt_id ADD avatar_file_id text`);
  } catch (error: any) {
    if (!error.message?.includes('already exists') && !error.message?.includes('Invalid column name')) {
      console.warn('Warning: Could not add avatar_file_id to users_by_gryt_id:', error.message);
    }
  }
  try {
    await client.execute(`ALTER TABLE users_by_server_id ADD avatar_file_id text`);
  } catch (error: any) {
    if (!error.message?.includes('already exists') && !error.message?.includes('Invalid column name')) {
      console.warn('Warning: Could not add avatar_file_id to users_by_server_id:', error.message);
    }
  }

  // Set default value for existing users (set them as active)
  try {
    const grytUsers = await client.execute(`SELECT gryt_user_id FROM users_by_gryt_id`);
    const serverUsers = await client.execute(`SELECT server_user_id FROM users_by_server_id`);
    
    for (const row of grytUsers.rows) {
      await client.execute(
        `UPDATE users_by_gryt_id SET is_active = true WHERE gryt_user_id = ?`,
        [row.gryt_user_id],
        { prepare: true }
      );
    }
    
    for (const row of serverUsers.rows) {
      await client.execute(
        `UPDATE users_by_server_id SET is_active = true WHERE server_user_id = ?`,
        [row.server_user_id],
        { prepare: true }
      );
    }
    
    console.log(`✅ Set default is_active = true for ${grytUsers.rows.length} users in users_by_gryt_id and ${serverUsers.rows.length} users in users_by_server_id`);
  } catch (error: any) {
    console.error('❌ Failed to set default is_active values:', error.message);
  }

  await client.execute(
    `CREATE TABLE IF NOT EXISTS messages_by_conversation (
      conversation_id text,
      created_at timestamp,
      message_id uuid,
      sender_server_id text,
      text text,
      attachments list<text>,
      reactions text,
      PRIMARY KEY ((conversation_id), created_at, message_id)
    ) WITH CLUSTERING ORDER BY (created_at ASC, message_id ASC)`
  );

  // Add reactions column if it doesn't exist (for existing tables)
  try {
    await client.execute(`ALTER TABLE messages_by_conversation ADD reactions text`);
  } catch (error: any) {
    if (!error.message?.includes('already exists') && !error.message?.includes('Invalid column name')) {
      console.warn('Warning: Could not add reactions column:', error.message);
    }
  }

  try {
    await client.execute(`ALTER TABLE messages_by_conversation ADD reply_to_message_id text`);
  } catch (error: any) {
    if (!error.message?.includes('already exists') && !error.message?.includes('Invalid column name')) {
      console.warn('Warning: Could not add reply_to_message_id column:', error.message);
    }
  }

  try {
    await client.execute(`ALTER TABLE messages_by_conversation ADD edited_at timestamp`);
  } catch (error: any) {
    if (!error.message?.includes('already exists') && !error.message?.includes('Invalid column name')) {
      console.warn('Warning: Could not add edited_at column:', error.message);
    }
  }

  await client.execute(
    `CREATE TABLE IF NOT EXISTS files_by_id (
      file_id uuid PRIMARY KEY,
      s3_key text,
      mime text,
      size bigint,
      width int,
      height int,
      thumbnail_key text,
      original_name text,
      created_at timestamp
    )`
  );

  try {
    await client.execute(`ALTER TABLE files_by_id ADD original_name text`);
  } catch (error: any) {
    if (!error.message?.includes('already exists') && !error.message?.includes('Invalid column name')) {
      console.warn('Warning: Could not add original_name column:', error.message);
    }
  }

  // Refresh tokens for per-user revocable sessions
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_refresh_tokens (
      token_id text PRIMARY KEY,
      gryt_user_id text,
      server_user_id text,
      created_at timestamp,
      expires_at timestamp,
      revoked boolean
    )`
  );

  // Secondary index for per-user queries (revoke all tokens for a user)
  try {
    await client.execute(
      `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_gryt_user ON server_refresh_tokens (gryt_user_id)`
    );
  } catch {
    // Index may already exist
  }

  // Custom emojis (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS server_emojis_by_name (
      name text PRIMARY KEY,
      file_id uuid,
      s3_key text,
      uploaded_by_server_user_id text,
      created_at timestamp
    )`
  );

  // Message reports (ONE server per keyspace)
  await client.execute(
    `CREATE TABLE IF NOT EXISTS message_reports (
      bucket text,
      created_at timestamp,
      report_id uuid,
      message_id text,
      conversation_id text,
      reporter_server_user_id text,
      message_text text,
      message_sender_server_id text,
      message_sender_nickname text,
      status text,
      resolved_by_server_user_id text,
      resolved_at timestamp,
      PRIMARY KEY ((bucket), created_at, report_id)
    ) WITH CLUSTERING ORDER BY (created_at DESC, report_id DESC)`
  );
}

// Re-export everything from sub-modules so existing imports continue to work
export * from "./users";
export * from "./messages";
export * from "./tokens";
export * from "./servers";
export * from "./channels";
export * from "./invites";
export * from "./emojis";
export * from "./reports";
