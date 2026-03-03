import { randomBytes, randomUUID } from "crypto";

import type { WebhookRecord } from "../interfaces";
import { fromIso, getSqliteDb, toIso } from "./connection";

function rowToWebhook(r: Record<string, unknown>): WebhookRecord {
  return {
    webhook_id: r.webhook_id as string,
    token: r.token as string,
    channel_id: r.channel_id as string,
    display_name: r.display_name as string,
    avatar_file_id: (r.avatar_file_id as string) ?? null,
    created_by_server_user_id: r.created_by_server_user_id as string,
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

export async function createWebhook(
  channelId: string,
  displayName: string,
  createdByServerUserId: string,
  avatarFileId?: string | null,
): Promise<WebhookRecord> {
  const db = getSqliteDb();
  const now = new Date();
  const record: WebhookRecord = {
    webhook_id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    channel_id: channelId,
    display_name: displayName,
    avatar_file_id: avatarFileId ?? null,
    created_by_server_user_id: createdByServerUserId,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO webhooks (webhook_id, token, channel_id, display_name, avatar_file_id, created_by_server_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.webhook_id,
    record.token,
    record.channel_id,
    record.display_name,
    record.avatar_file_id,
    record.created_by_server_user_id,
    toIso(record.created_at),
    toIso(record.updated_at),
  );

  return record;
}

export async function getWebhookById(webhookId: string): Promise<WebhookRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM webhooks WHERE webhook_id = ?`).get(webhookId) as Record<string, unknown> | undefined;
  return row ? rowToWebhook(row) : null;
}

export async function getWebhookByIdAndToken(webhookId: string, token: string): Promise<WebhookRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM webhooks WHERE webhook_id = ? AND token = ?`).get(webhookId, token) as Record<string, unknown> | undefined;
  return row ? rowToWebhook(row) : null;
}

export async function listAllWebhooks(): Promise<WebhookRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM webhooks ORDER BY created_at DESC`).all() as Record<string, unknown>[];
  return rows.map(rowToWebhook);
}

export async function getWebhooksByIds(ids: string[]): Promise<Map<string, WebhookRecord>> {
  const result = new Map<string, WebhookRecord>();
  if (ids.length === 0) return result;
  const all = await listAllWebhooks();
  for (const w of all) {
    if (ids.includes(w.webhook_id)) result.set(w.webhook_id, w);
  }
  return result;
}

export async function updateWebhook(
  webhookId: string,
  updates: { display_name?: string; channel_id?: string; avatar_file_id?: string | null },
): Promise<WebhookRecord | null> {
  const db = getSqliteDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.display_name !== undefined) { sets.push("display_name = ?"); vals.push(updates.display_name); }
  if (updates.channel_id !== undefined) { sets.push("channel_id = ?"); vals.push(updates.channel_id); }
  if (updates.avatar_file_id !== undefined) { sets.push("avatar_file_id = ?"); vals.push(updates.avatar_file_id); }
  if (sets.length === 0) return getWebhookById(webhookId);
  sets.push("updated_at = ?");
  vals.push(toIso(new Date()));
  vals.push(webhookId);
  db.prepare(`UPDATE webhooks SET ${sets.join(", ")} WHERE webhook_id = ?`).run(...vals);
  return getWebhookById(webhookId);
}

export async function deleteWebhook(webhookId: string): Promise<boolean> {
  const db = getSqliteDb();
  const result = db.prepare(`DELETE FROM webhooks WHERE webhook_id = ?`).run(webhookId);
  return result.changes > 0;
}
