import { randomUUID } from "crypto";

import { CHANNEL_PERMISSIONS, isChannelPermission, type ChannelPermission } from "../../constants/permissions";
import type {
  ChannelPermissionRuleRecord,
  ChannelPermissionScopeRecord,
  RuleEffect,
  ServerChannelRecord,
  ServerSidebarItemRecord,
} from "../interfaces";
import { fromIso, getSqliteDb, intToBool, toIso } from "./connection";

export interface ResolvedChannelScope {
  /** What decides this channel. Null is every role's server-wide answer. */
  scopeId: string | null;
  /** The folder it sits in, or null at the top level. */
  folderId: string | null;
  followsFolder: boolean;
}

/**
 * The one place a channel's scope is worked out: its folder's while it follows
 * one, otherwise its own. `items` in listing order, since a channel's first row wins.
 */
export function resolveChannelScopes(
  channels: readonly Pick<ServerChannelRecord, "channel_id" | "permission_scope_id" | "follows_folder">[],
  items: readonly Pick<ServerSidebarItemRecord, "item_id" | "kind" | "channel_id" | "parent_item_id" | "permission_scope_id">[],
): Map<string, ResolvedChannelScope> {
  const folderScopes = new Map<string, string | null>();
  for (const it of items) if (it.kind === "folder") folderScopes.set(it.item_id, it.permission_scope_id ?? null);

  const folderOf = new Map<string, string | null>();
  for (const it of items) {
    if (it.kind !== "channel" || !it.channel_id || folderOf.has(it.channel_id)) continue;
    const parent = it.parent_item_id ?? null;
    folderOf.set(it.channel_id, parent && folderScopes.has(parent) ? parent : null);
  }

  const resolved = new Map<string, ResolvedChannelScope>();
  for (const c of channels) {
    const folderId = folderOf.get(c.channel_id) ?? null;
    // A scope of its own wins, so an older build writing one is never overridden.
    const followsFolder = folderId !== null && !c.permission_scope_id && c.follows_folder;
    resolved.set(c.channel_id, {
      scopeId: followsFolder ? folderScopes.get(folderId as string) ?? null : c.permission_scope_id ?? null,
      folderId,
      followsFolder,
    });
  }
  return resolved;
}

/** A private scope belongs to one channel or one folder, so it goes when the
    last thing using it does. A template stays. */
export function dropPermissionScopeIfUnused(scopeId: string): void {
  const db = getSqliteDb();
  const scope = db
    .prepare(`SELECT is_template FROM channel_permission_scopes WHERE scope_id = ?`)
    .get(scopeId) as { is_template: number } | undefined;
  if (!scope || scope.is_template) return;

  const used = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM channels WHERE permission_scope_id = ?)
            + (SELECT COUNT(*) FROM sidebar_items WHERE permission_scope_id = ?) AS n`,
    )
    .get(scopeId, scopeId) as { n: number };
  if (used.n > 0) return;

  db.prepare(`DELETE FROM channel_permission_rules WHERE scope_id = ?`).run(scopeId);
  db.prepare(`DELETE FROM channel_permission_scopes WHERE scope_id = ?`).run(scopeId);
}

/**
 * Leaving a folder never opens a channel: one that followed a folder's scope and
 * sits in none now keeps it as its own. Runs inside the caller's transaction.
 */
export function keepScopesOfChannelsLeavingFolders(
  before: Map<string, ResolvedChannelScope>,
  after: Map<string, ResolvedChannelScope>,
): void {
  const db = getSqliteDb();
  const now = toIso(new Date());

  for (const [channelId, was] of before) {
    const is = after.get(channelId);
    if (!was.followsFolder || !was.scopeId || !is || is.folderId) continue;

    const scope = db
      .prepare(`SELECT is_template FROM channel_permission_scopes WHERE scope_id = ?`)
      .get(was.scopeId) as { is_template: number } | undefined;
    if (!scope) continue;

    // A folder's private scope is copied, not shared: it dies with the folder.
    let own = was.scopeId;
    if (!scope.is_template) {
      own = `scope_${randomUUID().slice(0, 12)}`;
      db.prepare(
        `INSERT INTO channel_permission_scopes (scope_id, name, is_template, is_system, created_at, updated_at)
         VALUES (?, NULL, 0, 0, ?, ?)`,
      ).run(own, now, now);
      db.prepare(
        `INSERT INTO channel_permission_rules (scope_id, role_id, permission, effect, created_at)
         SELECT ?, role_id, permission, effect, ? FROM channel_permission_rules WHERE scope_id = ?`,
      ).run(own, now, was.scopeId);
    }
    db.prepare(`UPDATE channels SET permission_scope_id = ?, follows_folder = 0, updated_at = ? WHERE channel_id = ?`)
      .run(own, now, channelId);
  }
}

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

/** One read rather than one per scope: the visibility filter needs all of them
    at once, so the caller reading everything is the common one, and it caches. */
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

/** A rule absent from the payload was set back to inherit, so applying only what
    is present makes inherit unreachable. One transaction. */
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

  // Bracketed by hand, since node:sqlite has no wrapper: stopping between the
  // delete and the inserts reads as inherit everything.
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

/** Any choice made here is the channel's own, Everyone included, unless
    `followFolder` hands it back to its folder. The private scope it owned goes. */
export async function setChannelPermissionScope(
  channelId: string,
  scopeId: string | null,
  { followFolder = false }: { followFolder?: boolean } = {},
): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());

  db.exec("BEGIN");
  try {
    const previous = db
      .prepare(`SELECT permission_scope_id FROM channels WHERE channel_id = ?`)
      .get(channelId) as { permission_scope_id: string | null } | undefined;

    db.prepare(`UPDATE channels SET permission_scope_id = ?, follows_folder = ?, updated_at = ? WHERE channel_id = ?`)
      .run(scopeId, followFolder && !scopeId ? 1 : 0, now, channelId);

    const old = previous?.permission_scope_id;
    if (old && old !== scopeId) dropPermissionScopeIfUnused(old);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The folder's half of `setChannelPermissionScope`. Its channels read it
    through `resolveChannelScopes`, so nothing is written to them. */
export async function setFolderPermissionScope(folderItemId: string, scopeId: string | null): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());

  db.exec("BEGIN");
  try {
    const previous = db
      .prepare(`SELECT permission_scope_id FROM sidebar_items WHERE item_id = ? AND kind = 'folder'`)
      .get(folderItemId) as { permission_scope_id: string | null } | undefined;

    db.prepare(`UPDATE sidebar_items SET permission_scope_id = ?, updated_at = ? WHERE item_id = ? AND kind = 'folder'`)
      .run(scopeId, now, folderItemId);

    const old = previous?.permission_scope_id;
    if (old && old !== scopeId) dropPermissionScopeIfUnused(old);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Channels and folders on it go to Everyone rather than point at nothing, so
    what the dropdown shows is what applies. */
export async function deletePermissionTemplate(scopeId: string): Promise<void> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE channels SET permission_scope_id = NULL, follows_folder = 0, updated_at = ? WHERE permission_scope_id = ?`)
      .run(now, scopeId);
    db.prepare(`UPDATE sidebar_items SET permission_scope_id = NULL, updated_at = ? WHERE permission_scope_id = ?`)
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
