import { randomUUID } from "crypto";

import { CHANNEL_PERMISSIONS, isChannelPermission, type ChannelPermission } from "../../constants/permissions";
import type { ChannelPermissionRuleRecord, ChannelPermissionScopeRecord, RuleEffect } from "../interfaces";
import { fromIso, getSqliteDb, intToBool, toIso } from "./connection";

function rowToScope(r: Record<string, unknown>): ChannelPermissionScopeRecord {
  return {
    scope_id: r.scope_id as string,
    name: (r.name as string) ?? null,
    is_template: intToBool(r.is_template as number),
    is_system: intToBool(r.is_system as number),
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

function rowToRule(r: Record<string, unknown>): ChannelPermissionRuleRecord {
  return {
    scope_id: r.scope_id as string,
    role_id: r.role_id as string,
    permission: r.permission as ChannelPermission,
    effect: (r.effect === "allow" ? "allow" : "deny") as RuleEffect,
  };
}

/** Every named template, for the settings list and the channel dropdown. */
export async function listPermissionTemplates(): Promise<ChannelPermissionScopeRecord[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM channel_permission_scopes WHERE is_template = 1 ORDER BY is_system DESC, name ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToScope);
}

export async function getPermissionScope(scopeId: string): Promise<ChannelPermissionScopeRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM channel_permission_scopes WHERE scope_id = ?`).get(scopeId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToScope(row) : null;
}

/**
 * Every rule in the server, keyed by scope.
 *
 * One read rather than one per scope. Resolution needs whichever scope the
 * channel points at, and the visibility filter needs all of them at once to
 * answer "which channels may this member see" — so the caller that reads them
 * all is the common one, and it caches.
 */
export async function listAllPermissionRules(): Promise<Map<string, ChannelPermissionRuleRecord[]>> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM channel_permission_rules`).all() as Record<string, unknown>[];
  const byScope = new Map<string, ChannelPermissionRuleRecord[]>();
  for (const row of rows) {
    const rule = rowToRule(row);
    if (!isChannelPermission(rule.permission)) continue;
    const list = byScope.get(rule.scope_id);
    if (list) list.push(rule);
    else byScope.set(rule.scope_id, [rule]);
  }
  return byScope;
}

export async function listPermissionRules(scopeId: string): Promise<ChannelPermissionRuleRecord[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM channel_permission_rules WHERE scope_id = ?`)
    .all(scopeId) as Record<string, unknown>[];
  return rows.map(rowToRule).filter((r) => isChannelPermission(r.permission));
}

export async function createPermissionScope(options: {
  scopeId?: string;
  name?: string | null;
  isTemplate?: boolean;
  isSystem?: boolean;
}): Promise<string> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  const scopeId = (options.scopeId?.trim() || `scope_${randomUUID().slice(0, 12)}`).slice(0, 64);
  const name = options.name == null ? null : String(options.name).trim().slice(0, 60) || null;

  db.prepare(
    `INSERT INTO channel_permission_scopes (scope_id, name, is_template, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_id) DO UPDATE SET name = ?, updated_at = ?`,
  ).run(scopeId, name, options.isTemplate ? 1 : 0, options.isSystem ? 1 : 0, now, now, name, now);

  return scopeId;
}

export async function renamePermissionTemplate(scopeId: string, name: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE channel_permission_scopes SET name = ?, updated_at = ? WHERE scope_id = ? AND is_template = 1`)
    .run(String(name).trim().slice(0, 60), toIso(new Date()), scopeId);
}

/**
 * Replace a scope's rules wholesale. The editor sends the matrix it is showing,
 * so a rule absent from the payload has been set back to inherit and its row
 * has to go — applying only what is present makes inherit unreachable.
 *
 * One transaction: a half-applied matrix is a channel with permissions nobody
 * chose.
 */
export async function replacePermissionRules(
  scopeId: string,
  rules: { roleId: string; permission: string; effect: string }[],
): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());

  const clean = rules
    .filter((r) => isChannelPermission(r.permission))
    .filter((r) => r.effect === "allow" || r.effect === "deny")
    .map((r) => ({
      roleId: String(r.roleId).trim().slice(0, 64),
      permission: r.permission,
      effect: r.effect,
    }))
    .filter((r) => r.roleId.length > 0);

  // node:sqlite has no transaction() wrapper, so this is bracketed by hand the
  // way emojis.ts does it. Stopping between the delete and the inserts would
  // leave the scope with no rules at all, which reads as "inherit everything" —
  // a channel briefly open to everyone.
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM channel_permission_rules WHERE scope_id = ?`).run(scopeId);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO channel_permission_rules (scope_id, role_id, permission, effect, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of clean) insert.run(scopeId, r.roleId, r.permission, r.effect, now);
    db.prepare(`UPDATE channel_permission_scopes SET updated_at = ? WHERE scope_id = ?`).run(now, scopeId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Point a channel at a scope, or at nothing.
 *
 * Deleting the scope it used to own is part of this. A private "Custom" scope
 * belongs to exactly one channel, so switching that channel to a template
 * leaves it unreachable — and a row nothing points at is a row somebody has to
 * work out the meaning of later. A shared template is left alone.
 */
export async function setChannelPermissionScope(channelId: string, scopeId: string | null): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());

  db.exec("BEGIN");
  try {
    const previous = db
      .prepare(`SELECT permission_scope_id FROM channels WHERE channel_id = ?`)
      .get(channelId) as { permission_scope_id: string | null } | undefined;

    db.prepare(`UPDATE channels SET permission_scope_id = ?, updated_at = ? WHERE channel_id = ?`)
      .run(scopeId, now, channelId);

    const old = previous?.permission_scope_id;
    if (old && old !== scopeId) {
      const stillUsed = db
        .prepare(`SELECT COUNT(*) AS n FROM channels WHERE permission_scope_id = ?`)
        .get(old) as { n: number };
      const scope = db
        .prepare(`SELECT is_template FROM channel_permission_scopes WHERE scope_id = ?`)
        .get(old) as { is_template: number } | undefined;
      if (scope && !scope.is_template && stillUsed.n === 0) {
        db.prepare(`DELETE FROM channel_permission_rules WHERE scope_id = ?`).run(old);
        db.prepare(`DELETE FROM channel_permission_scopes WHERE scope_id = ?`).run(old);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Delete a template, and put every channel using it back to inheriting.
 *
 * Not left dangling. A channel pointing at a scope that is gone would resolve
 * to no rules, which is the same answer as inheriting — but only by accident,
 * and the settings UI would show a dropdown with nothing selected.
 */
export async function deletePermissionTemplate(scopeId: string): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE channels SET permission_scope_id = NULL, updated_at = ? WHERE permission_scope_id = ?`)
      .run(now, scopeId);
    db.prepare(`DELETE FROM channel_permission_rules WHERE scope_id = ?`).run(scopeId);
    db.prepare(`DELETE FROM channel_permission_scopes WHERE scope_id = ? AND is_system = 0`).run(scopeId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Drop every rule naming a role that no longer exists. */
export async function purgeRulesForRole(roleId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`DELETE FROM channel_permission_rules WHERE role_id = ?`).run(roleId);
}

export { CHANNEL_PERMISSIONS };
