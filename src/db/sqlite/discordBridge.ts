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
export type DiscordBridgeCopyStatus = "idle" | "running" | "done" | "failed";

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
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

/** A new token keeps the linked guild, so pasting a fresh token after a reset picks up where it was. */
export function saveDiscordBridgeApp(applicationId: string, botToken: string): void {
  const now = toIso(new Date());
  getSqliteDb()
    .prepare(
      `INSERT INTO discord_bridge (id, application_id, bot_token, status, created_at, updated_at)
       VALUES ('bridge', ?, ?, 'connecting', ?, ?)
       ON CONFLICT(id) DO UPDATE SET application_id = excluded.application_id, bot_token = excluded.bot_token,
         status = 'connecting', updated_at = excluded.updated_at`,
    )
    .run(applicationId, botToken, now, now);
}

export function updateDiscordBridge(patch: {
  status?: DiscordBridgeStatus;
  guild_id?: string | null;
  guild_name?: string | null;
  direction?: DiscordBridgeDirection;
  copy_status?: DiscordBridgeCopyStatus;
  copy_progress?: string;
  copy_started_by?: string;
}): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
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
