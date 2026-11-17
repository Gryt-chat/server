import type { DiscordImportProgress } from "./discordImports";
import { fromIso, getSqliteDb, toIso } from "./connection";

export type DiscordBridgeStatus =
  | "connecting"
  | "token_invalid"
  | "intents_missing"
  | "waiting_for_invite"
  | "linked"
  | "removed";

export type DiscordBridgeDirection = "to_gryt" | "both" | "to_discord";
export type DiscordBridgeCopyStatus = "idle" | "running" | "paused" | "done" | "failed";

/** What the owner can switch off in the live bridge. Messages off stops new ones both ways. */
export const SYNC_KINDS = ["messages", "edits", "deletes", "replies", "reactions", "emoji", "pins", "threads", "files"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export interface DiscordBridgeRecord {
  application_id: string;
  bot_token: string;
  guild_id: string | null;
  guild_name: string | null;
  status: DiscordBridgeStatus;
  direction: DiscordBridgeDirection | null;
  copy_status: DiscordBridgeCopyStatus;
  copy_progress: DiscordImportProgress | null;
  copy_started_by: string | null;
  sync_new_channels: boolean;
  sync_off: SyncKind[];
  copy_identity: boolean;
  claim_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export function getDiscordBridge(): DiscordBridgeRecord | null {
  const r = getSqliteDb().prepare(`SELECT * FROM discord_bridge WHERE id = 'bridge'`).get() as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    application_id: r.application_id as string,
    bot_token: r.bot_token as string,
    guild_id: (r.guild_id as string) ?? null,
    guild_name: (r.guild_name as string) ?? null,
    status: r.status as DiscordBridgeStatus,
    direction: (r.direction as DiscordBridgeDirection) ?? null,
    copy_status: r.copy_status as DiscordBridgeCopyStatus,
    copy_progress: r.copy_progress ? (JSON.parse(r.copy_progress as string) as DiscordImportProgress) : null,
    copy_started_by: (r.copy_started_by as string) ?? null,
    sync_new_channels: r.sync_new_channels !== 0,
    sync_off: parseSyncOff(r.sync_off),
    copy_identity: r.copy_identity === 1,
    claim_id: (r.claim_id as string) ?? null,
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

/** A new token keeps the linked guild, so pasting a fresh token after a reset picks up where it was. */
export function saveDiscordBridgeApp(applicationId: string, botToken: string, claimId: string | null = null): void {
  const now = toIso(new Date());
  getSqliteDb()
    .prepare(
      `INSERT INTO discord_bridge (id, application_id, bot_token, status, claim_id, created_at, updated_at)
       VALUES ('bridge', ?, ?, 'connecting', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, bot_token = excluded.bot_token,
         status = 'connecting', claim_id = COALESCE(excluded.claim_id, discord_bridge.claim_id), updated_at = excluded.updated_at`,
    )
    .run(applicationId, botToken, claimId, now, now);
}

export function updateDiscordBridge(patch: {
  status?: DiscordBridgeStatus;
  guild_id?: string | null;
  guild_name?: string | null;
  direction?: DiscordBridgeDirection;
  copy_status?: DiscordBridgeCopyStatus;
  copy_progress?: string;
  copy_started_by?: string;
  sync_new_channels?: number;
  sync_off?: string;
  copy_identity?: number;
}): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  getSqliteDb()
    .prepare(`UPDATE discord_bridge SET ${sets.join(", ")}, updated_at = ? WHERE id = 'bridge'`)
    .run(...values, toIso(new Date()));
}

function parseSyncOff(raw: unknown): SyncKind[] {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]") as unknown;
    return Array.isArray(v) ? v.filter((k): k is SyncKind => (SYNC_KINDS as readonly unknown[]).includes(k)) : [];
  } catch {
    return [];
  }
}

/** Cheap enough per event: one row, read by primary key. */
export function bridgeSyncs(kind: SyncKind): boolean {
  return !(getDiscordBridge()?.sync_off ?? []).includes(kind);
}

export function clearDiscordBridge(): void {
  getSqliteDb().prepare(`DELETE FROM discord_bridge WHERE id = 'bridge'`).run();
}

export interface DiscordBridgeChannelRecord {
  discord_channel_id: string;
  gryt_channel_id: string;
  backfill_before: string | null;
  backfill_done: boolean;
}

export function getDiscordBridgeChannel(discordChannelId: string): DiscordBridgeChannelRecord | null {
  const r = getSqliteDb().prepare(`SELECT * FROM discord_bridge_channels WHERE discord_channel_id = ?`).get(discordChannelId) as
    | { discord_channel_id: string; gryt_channel_id: string; backfill_before: string | null; backfill_done: number }
    | undefined;
  return r ? { ...r, backfill_done: r.backfill_done === 1 } : null;
}

export function saveDiscordBridgeChannel(c: DiscordBridgeChannelRecord): void {
  getSqliteDb()
    .prepare(
      `INSERT INTO discord_bridge_channels (discord_channel_id, gryt_channel_id, backfill_before, backfill_done) VALUES (?, ?, ?, ?)
       ON CONFLICT(discord_channel_id) DO UPDATE SET gryt_channel_id = excluded.gryt_channel_id,
         backfill_before = excluded.backfill_before, backfill_done = excluded.backfill_done`,
    )
    .run(c.discord_channel_id, c.gryt_channel_id, c.backfill_before, c.backfill_done ? 1 : 0);
}

export interface DiscordMessageLink {
  gryt_message_id: string;
  gryt_conversation_id: string;
  discord_channel_id: string;
  discord_message_id: string;
  from_gryt: boolean;
}

export function rememberDiscordMessages(links: DiscordMessageLink[]): void {
  if (links.length === 0) return;
  const insert = getSqliteDb().prepare(
    `INSERT OR IGNORE INTO discord_bridge_messages (gryt_message_id, gryt_conversation_id, discord_channel_id, discord_message_id, from_gryt) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const l of links) insert.run(l.gryt_message_id, l.gryt_conversation_id, l.discord_channel_id, l.discord_message_id, l.from_gryt ? 1 : 0);
}

export function discordMessageFor(grytMessageId: string): DiscordMessageLink | null {
  const r = getSqliteDb().prepare(`SELECT * FROM discord_bridge_messages WHERE gryt_message_id = ?`).get(grytMessageId) as
    | (Omit<DiscordMessageLink, "from_gryt"> & { from_gryt: number })
    | undefined;
  return r ? { ...r, from_gryt: r.from_gryt === 1 } : null;
}

/** The Discord channel or thread behind a Gryt channel or thread id, with its webhook once one is made. */
export function discordChannelFor(grytChannelId: string): { discord_channel_id: string; webhook_id: string | null; webhook_token: string | null } | null {
  const r = getSqliteDb()
    .prepare(`SELECT discord_channel_id, webhook_id, webhook_token FROM discord_bridge_channels WHERE gryt_channel_id = ? LIMIT 1`)
    .get(grytChannelId) as { discord_channel_id: string; webhook_id: string | null; webhook_token: string | null } | undefined;
  return r ?? null;
}

export function saveDiscordChannelWebhook(discordChannelId: string, webhookId: string, webhookToken: string): void {
  getSqliteDb().prepare(`UPDATE discord_bridge_channels SET webhook_id = ?, webhook_token = ? WHERE discord_channel_id = ?`).run(webhookId, webhookToken, discordChannelId);
}

export function bridgeWebhookIds(): Set<string> {
  const rows = getSqliteDb().prepare(`SELECT webhook_id FROM discord_bridge_channels WHERE webhook_id IS NOT NULL`).all() as { webhook_id: string }[];
  return new Set(rows.map((r) => r.webhook_id));
}

export interface DiscordMemberLink {
  discord_user_id: string;
  server_user_id: string;
  linked_by: string;
  proof: "code" | "admin";
  created_at: Date;
}

export function linkDiscordMember(discordUserId: string, serverUserId: string, linkedBy: string, proof: "code" | "admin"): void {
  getSqliteDb()
    .prepare(
      `INSERT INTO discord_member_links (discord_user_id, server_user_id, linked_by, proof, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(discord_user_id) DO UPDATE SET server_user_id = excluded.server_user_id, linked_by = excluded.linked_by, proof = excluded.proof, created_at = excluded.created_at`,
    )
    .run(discordUserId, serverUserId, linkedBy, proof, toIso(new Date()));
}

export function unlinkDiscordMember(discordUserId: string): boolean {
  return getSqliteDb().prepare(`DELETE FROM discord_member_links WHERE discord_user_id = ?`).run(discordUserId).changes > 0;
}

export function listDiscordMemberLinks(): DiscordMemberLink[] {
  const rows = getSqliteDb().prepare(`SELECT * FROM discord_member_links`).all() as (Omit<DiscordMemberLink, "created_at"> & { created_at: string })[];
  return rows.map((r) => ({ ...r, created_at: fromIso(r.created_at) }));
}

/** Discord user id → Gryt member, for the ones asked about. */
export function discordLinksFor(discordUserIds: string[]): Map<string, string> {
  if (discordUserIds.length === 0) return new Map();
  const rows = getSqliteDb()
    .prepare(`SELECT discord_user_id, server_user_id FROM discord_member_links WHERE discord_user_id IN (${discordUserIds.map(() => "?").join(",")})`)
    .all(...discordUserIds) as { discord_user_id: string; server_user_id: string }[];
  return new Map(rows.map((r) => [r.discord_user_id, r.server_user_id]));
}

/** Everyone who wrote something that came from Discord, newest name first. */
export function listDiscordAuthors(): { discord_user_id: string; name: string | null; messages: number }[] {
  const rows = getSqliteDb()
    .prepare(
      `SELECT substr(sender_server_id, 9) AS discord_user_id, MAX(sender_display_name) AS name, COUNT(*) AS messages
       FROM messages WHERE sender_server_id LIKE 'discord:%' GROUP BY sender_server_id ORDER BY messages DESC LIMIT 500`,
    )
    .all() as { discord_user_id: string; name: string | null; messages: number }[];
  return rows;
}

/** Where a Discord person's copied messages are, for deleting them on request. */
export function discordPersonMessageIds(discordUserId: string): { conversation_id: string; message_id: string }[] {
  return getSqliteDb()
    .prepare(`SELECT conversation_id, message_id FROM messages WHERE sender_server_id = ?`)
    .all(`discord:${discordUserId}`) as { conversation_id: string; message_id: string }[];
}

/** The Gryt channel a Discord channel copies into: the owner's match, a new one by default, or null when skipped. */
export function grytChannelFor(discordChannelId: string, derived: string): string | null {
  const r = getSqliteDb().prepare(`SELECT gryt_channel_id, skip FROM discord_bridge_channels WHERE discord_channel_id = ?`).get(discordChannelId) as
    | { gryt_channel_id: string; skip: number }
    | undefined;
  if (!r) return derived;
  return r.skip === 1 ? null : r.gryt_channel_id;
}

/** The owner's matches, before or after a copy. A changed match only moves what's copied from now on. */
export function setDiscordChannelMatch(discordChannelId: string, target: { grytChannelId: string } | "skip"): void {
  const skip = target === "skip";
  const gryt = skip ? "" : target.grytChannelId;
  getSqliteDb()
    .prepare(
      `INSERT INTO discord_bridge_channels (discord_channel_id, gryt_channel_id, backfill_before, backfill_done, skip) VALUES (?, ?, NULL, 0, ?)
       ON CONFLICT(discord_channel_id) DO UPDATE SET gryt_channel_id = CASE WHEN excluded.skip = 1 THEN gryt_channel_id ELSE excluded.gryt_channel_id END, skip = excluded.skip`,
    )
    .run(discordChannelId, gryt, skip ? 1 : 0);
}

export type ExcludedKind = "discord" | "gryt";

/** The owner switched this person's sync off. Everyone is in until then. */
export function isExcludedFromBridge(kind: ExcludedKind, id: string): boolean {
  return !!getSqliteDb().prepare(`SELECT 1 FROM discord_bridge_excluded WHERE kind = ? AND id = ?`).get(kind, id);
}

export function setExcludedFromBridge(kind: ExcludedKind, id: string, excluded: boolean): void {
  const db = getSqliteDb();
  if (excluded) db.prepare(`INSERT OR IGNORE INTO discord_bridge_excluded (kind, id, created_at) VALUES (?, ?, ?)`).run(kind, id, toIso(new Date()));
  else db.prepare(`DELETE FROM discord_bridge_excluded WHERE kind = ? AND id = ?`).run(kind, id);
}

export function listExcludedFromBridge(kind: ExcludedKind): string[] {
  return (getSqliteDb().prepare(`SELECT id FROM discord_bridge_excluded WHERE kind = ?`).all(kind) as { id: string }[]).map((r) => r.id);
}

/** The live tab's header: how much is matched, and when the last matched message was. */
export function discordBridgeStats(): { messagesMatched: number; lastMessageAt: string | null } {
  const m = getSqliteDb()
    .prepare(`SELECT COUNT(*) AS n, MAX(m.created_at) AS last FROM discord_bridge_messages b LEFT JOIN messages m ON m.conversation_id = b.gryt_conversation_id AND m.message_id = b.gryt_message_id`)
    .get() as { n: number; last: string | null };
  return { messagesMatched: m.n, lastMessageAt: m.last };
}

/** The Discord person a member is linked to, if any; an admin link is one to one. */
export function discordPersonLinkedTo(serverUserId: string): string | null {
  const r = getSqliteDb().prepare(`SELECT discord_user_id FROM discord_member_links WHERE server_user_id = ?`).get(serverUserId) as { discord_user_id: string } | undefined;
  return r?.discord_user_id ?? null;
}

/** Whether any channel here has a message yet: an empty server just becomes a copy of the Discord one. */
export function channelsHaveMessages(): boolean {
  return !!getSqliteDb().prepare(`SELECT 1 FROM messages m JOIN channels c ON c.channel_id = m.conversation_id LIMIT 1`).get();
}

/** Every copied message from a Discord person shows their current name and picture, as Discord does. */
export function updateDiscordSenderProfile(discordUserId: string, name: string, avatarFileId: string | null): number {
  return Number(getSqliteDb()
    .prepare(`UPDATE messages SET sender_display_name = ?, sender_avatar_file_id = COALESCE(?, sender_avatar_file_id) WHERE sender_server_id = ?`)
    .run(name, avatarFileId, `discord:${discordUserId}`).changes);
}
