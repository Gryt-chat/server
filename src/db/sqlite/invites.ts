import { randomBytes, randomUUID } from "crypto";

import type { ServerAuditRecord, ServerInviteRecord } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

function rowToInvite(r: Record<string, unknown>): ServerInviteRecord {
  const maxUses = (r.max_uses as number) ?? 1;
  const usesRemaining = (r.uses_remaining as number) ?? 0;
  const isInfinite = maxUses < 0 || usesRemaining < 0;
  return {
    code: r.code as string,
    created_at: fromIso(r.created_at as string),
    created_by_server_user_id: (r.created_by_server_user_id as string) ?? null,
    expires_at: fromIsoNullable(r.expires_at as string | null),
    max_uses: isInfinite ? -1 : maxUses,
    uses_remaining: isInfinite ? -1 : usesRemaining,
    uses_consumed: (r.uses_consumed as number) ?? 0,
    revoked: (r.revoked as number) === 1,
    note: (r.note as string) ?? null,
  };
}

function generateInviteCode(): string {
  try { return randomBytes(9).toString("base64url").toLowerCase(); }
  catch { return randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12).toLowerCase(); }
}

export async function createServerInvite(createdByServerUserId: string | null, opts?: {
  expiresAt?: Date | null; infinite?: boolean; maxUses?: number; note?: string | null;
}): Promise<ServerInviteRecord> {
  const db = getSqliteDb();
  const now = new Date();
  const infinite = !!opts?.infinite;
  const maxUses = infinite ? -1 : Math.max(1, Math.min(1000, Math.floor(opts?.maxUses ?? 1)));
  const expiresAt = opts?.expiresAt ?? null;
  const note = (opts?.note ?? null) ? String(opts?.note).slice(0, 200) : null;
  const usesRemaining = infinite ? -1 : maxUses;

  for (let i = 0; i < 5; i++) {
    const code = generateInviteCode();
    try {
      db.prepare(`INSERT INTO invites (code, created_by_server_user_id, expires_at, max_uses, uses_remaining, uses_consumed, revoked, note, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(
        code, createdByServerUserId, expiresAt ? toIso(expiresAt) : null, maxUses, usesRemaining, note, toIso(now));
      return { code, created_at: now, created_by_server_user_id: createdByServerUserId, expires_at: expiresAt, max_uses: maxUses, uses_remaining: usesRemaining, uses_consumed: 0, revoked: false, note };
    } catch { /* collision, retry */ }
  }
  throw new Error("Failed to create invite code (collision)");
}

export async function listServerInvites(): Promise<ServerInviteRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM invites`).all() as Record<string, unknown>[];
  return rows.map(rowToInvite);
}

export async function revokeServerInvite(code: string, revoked = true): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE invites SET revoked = ? WHERE code = ?`).run(revoked ? 1 : 0, code);
}

export async function consumeServerInvite(code: string): Promise<{ ok: boolean; reason?: "not_found" | "revoked" | "expired" | "used_up" }> {
  const db = getSqliteDb();
  const norm = String(code || "").trim().toLowerCase();
  if (!norm) return { ok: false, reason: "not_found" };

  const row = db.prepare(`SELECT * FROM invites WHERE code = ?`).get(norm) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  const invite = rowToInvite(row);
  if (invite.revoked) return { ok: false, reason: "revoked" };
  if (invite.expires_at && invite.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  const isInfinite = invite.max_uses < 0 || invite.uses_remaining < 0;
  if (!isInfinite && invite.uses_remaining <= 0) return { ok: false, reason: "used_up" };

  if (!isInfinite) {
    const nextRemaining = invite.uses_remaining - 1;
    const nextRevoked = nextRemaining <= 0 ? 1 : 0;
    const result = db.prepare(`UPDATE invites SET uses_remaining = ?, uses_consumed = uses_consumed + 1, revoked = ? WHERE code = ? AND uses_remaining = ? AND revoked = 0`).run(
      nextRemaining, nextRevoked, norm, invite.uses_remaining);
    return result.changes > 0 ? { ok: true } : { ok: false, reason: "used_up" };
  } else {
    db.prepare(`UPDATE invites SET uses_consumed = uses_consumed + 1 WHERE code = ? AND revoked = 0`).run(norm);
    return { ok: true };
  }
}

const AUDIT_BUCKET = "default";

export async function insertServerAudit(entry: {
  actorServerUserId?: string | null; action: string; target?: string | null; meta?: Record<string, unknown>; createdAt?: Date;
}): Promise<ServerAuditRecord> {
  const db = getSqliteDb();
  const created_at = entry.createdAt ?? new Date();
  const event_id = randomUUID();
  const action = String(entry.action || "").slice(0, 80);
  const target = entry.target == null ? null : String(entry.target).slice(0, 120);
  const meta_json = entry.meta === undefined ? null : JSON.stringify(entry.meta).slice(0, 4000);

  db.prepare(`INSERT INTO audit_log (event_id, actor_server_user_id, action, target, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    event_id, entry.actorServerUserId ?? null, action, target, meta_json, toIso(created_at));

  return { created_at, event_id, actor_server_user_id: entry.actorServerUserId ?? null, action, target, meta_json };
}

export async function listServerAudit(limit = 50, before?: Date): Promise<ServerAuditRecord[]> {
  const db = getSqliteDb();
  const lim = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = before
    ? db.prepare(`SELECT * FROM audit_log WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`).all(toIso(before), lim)
    : db.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`).all(lim);
  return (rows as Record<string, unknown>[]).map((r) => ({
    created_at: fromIso(r.created_at as string),
    event_id: r.event_id as string,
    actor_server_user_id: (r.actor_server_user_id as string) ?? null,
    action: (r.action as string) ?? "",
    target: (r.target as string) ?? null,
    meta_json: (r.meta_json as string) ?? null,
  }));
}
