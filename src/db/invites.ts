import { randomBytes, randomUUID } from "crypto";
import { getScyllaClient } from "./scylla";

export interface ServerInviteRecord {
  code: string;
  created_at: Date;
  created_by_server_user_id: string | null;
  expires_at: Date | null;
  max_uses: number;
  uses_remaining: number;
  revoked: boolean;
  note: string | null;
}

export interface ServerAuditRecord {
  created_at: Date;
  event_id: string; // uuid
  actor_server_user_id: string | null;
  action: string;
  target: string | null;
  meta_json: string | null;
}

function rowToServerInvite(r: any): ServerInviteRecord {
  return {
    code: r["code"],
    created_at: r["created_at"] ?? new Date(0),
    created_by_server_user_id: r["created_by_server_user_id"] ?? null,
    expires_at: r["expires_at"] ?? null,
    max_uses: typeof r["max_uses"] === "number" ? r["max_uses"] : 1,
    uses_remaining: typeof r["uses_remaining"] === "number" ? r["uses_remaining"] : 0,
    revoked: typeof r["revoked"] === "boolean" ? r["revoked"] : false,
    note: r["note"] ?? null,
  };
}

function generateInviteCode(): string {
  try {
    return randomBytes(9).toString("base64url").toLowerCase();
  } catch {
    return randomBytes(9)
      .toString("base64")
      .replace(/[+/=]/g, "")
      .slice(0, 12)
      .toLowerCase();
  }
}

export async function createServerInvite(createdByServerUserId: string | null, opts?: {
  expiresAt?: Date | null;
  maxUses?: number;
  note?: string | null;
}): Promise<ServerInviteRecord> {
  const c = getScyllaClient();
  const now = new Date();
  const maxUses = Math.max(1, Math.min(1000, Math.floor(opts?.maxUses ?? 1)));
  const expiresAt = opts?.expiresAt ?? null;
  const note = (opts?.note ?? null) ? String(opts?.note).slice(0, 200) : null;

  for (let i = 0; i < 5; i++) {
    const code = generateInviteCode();
    const rs = await c.execute(
      `INSERT INTO server_invites_by_code
       (code, created_at, created_by_server_user_id, expires_at, max_uses, uses_remaining, revoked, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
      [code, now, createdByServerUserId, expiresAt, maxUses, maxUses, false, note],
      { prepare: true }
    );
    const r = rs.first();
    const applied = !!r?.["[applied]"];
    if (applied) {
      return {
        code,
        created_at: now,
        created_by_server_user_id: createdByServerUserId,
        expires_at: expiresAt,
        max_uses: maxUses,
        uses_remaining: maxUses,
        revoked: false,
        note,
      };
    }
  }
  throw new Error("Failed to create invite code (collision)");
}

export async function listServerInvites(): Promise<ServerInviteRecord[]> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT code, created_at, created_by_server_user_id, expires_at, max_uses, uses_remaining, revoked, note
     FROM server_invites_by_code`,
    [],
    { prepare: true }
  );
  return rs.rows.map((r) => rowToServerInvite(r));
}

export async function revokeServerInvite(code: string, revoked = true): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `UPDATE server_invites_by_code SET revoked = ? WHERE code = ?`,
    [!!revoked, code],
    { prepare: true }
  );
}

export async function consumeServerInvite(code: string): Promise<{ ok: boolean; reason?: "not_found" | "revoked" | "expired" | "used_up" }> {
  const c = getScyllaClient();
  const norm = String(code || "").trim().toLowerCase();
  if (!norm) return { ok: false, reason: "not_found" };

  for (let i = 0; i < 5; i++) {
    const rs = await c.execute(
      `SELECT code, created_at, created_by_server_user_id, expires_at, max_uses, uses_remaining, revoked, note
       FROM server_invites_by_code WHERE code = ?`,
      [norm],
      { prepare: true }
    );
    const r = rs.first();
    if (!r) return { ok: false, reason: "not_found" };
    const invite = rowToServerInvite(r);

    if (invite.revoked) return { ok: false, reason: "revoked" };
    if (invite.expires_at && invite.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    if ((invite.uses_remaining ?? 0) <= 0) return { ok: false, reason: "used_up" };

    const nextRemaining = invite.uses_remaining - 1;
    const nextRevoked = nextRemaining <= 0 ? true : false;
    const lwt = await c.execute(
      `UPDATE server_invites_by_code
       SET uses_remaining = ?, revoked = ?
       WHERE code = ?
       IF uses_remaining = ? AND revoked = ?`,
      [nextRemaining, nextRevoked, norm, invite.uses_remaining, false],
      { prepare: true }
    );
    const lr = lwt.first();
    const applied = !!lr?.["[applied]"];
    if (applied) return { ok: true };
  }

  return { ok: false, reason: "used_up" };
}

// ── Audit log ─────────────────────────────────────────────────────

const AUDIT_BUCKET = "default";

export async function insertServerAudit(entry: {
  actorServerUserId?: string | null;
  action: string;
  target?: string | null;
  meta?: any;
  createdAt?: Date;
}): Promise<ServerAuditRecord> {
  const c = getScyllaClient();
  const created_at = entry.createdAt ?? new Date();
  const event_id = randomUUID();
  const actor_server_user_id = entry.actorServerUserId ?? null;
  const action = String(entry.action || "").slice(0, 80);
  const target = entry.target == null ? null : String(entry.target).slice(0, 120);
  const meta_json = entry.meta === undefined ? null : JSON.stringify(entry.meta).slice(0, 4000);

  await c.execute(
    `INSERT INTO server_audit_by_id (bucket, created_at, event_id, actor_server_user_id, action, target, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [AUDIT_BUCKET, created_at, event_id, actor_server_user_id, action, target, meta_json],
    { prepare: true }
  );

  return {
    created_at,
    event_id,
    actor_server_user_id,
    action,
    target,
    meta_json,
  };
}

export async function listServerAudit(limit = 50, before?: Date): Promise<ServerAuditRecord[]> {
  const c = getScyllaClient();
  const lim = Math.max(1, Math.min(200, Math.floor(limit)));
  const rs = before
    ? await c.execute(
        `SELECT created_at, event_id, actor_server_user_id, action, target, meta_json
         FROM server_audit_by_id WHERE bucket = ? AND created_at < ? LIMIT ?`,
        [AUDIT_BUCKET, before, lim],
        { prepare: true }
      )
    : await c.execute(
        `SELECT created_at, event_id, actor_server_user_id, action, target, meta_json
         FROM server_audit_by_id WHERE bucket = ? LIMIT ?`,
        [AUDIT_BUCKET, lim],
        { prepare: true }
      );

  return rs.rows.map((r) => ({
    created_at: r["created_at"] ?? new Date(0),
    event_id: r["event_id"]?.toString?.() ?? String(r["event_id"] || ""),
    actor_server_user_id: r["actor_server_user_id"] ?? null,
    action: r["action"] ?? "",
    target: r["target"] ?? null,
    meta_json: r["meta_json"] ?? null,
  }));
}
