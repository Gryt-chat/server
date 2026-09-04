import {
  BUILT_IN_ROLES,
  isSystemRole,
  normalizePermissions,
  type Permission,
} from "../../constants/permissions";
import type { RoleDefinitionRecord } from "../interfaces";
import { fromIso, getSqliteDb, toIso } from "./connection";

/**
 * A stored `permissions` column, back as a list this build understands.
 *
 * Anything unparseable reads as no permissions at all. That is the fail-shut
 * direction: a role whose column got corrupted should stop working, not stop
 * being checked.
 */
function parsePermissions(raw: unknown): Permission[] {
  if (typeof raw !== "string") return [];
  try {
    return normalizePermissions(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * A stored threshold, or null when there isn't one.
 *
 * Zero and negatives read as null rather than as "grant immediately". A role
 * that grants itself the instant somebody arrives is a joining default, and
 * there is already a setting for that — reading a stray 0 as one would be a
 * promotion nobody configured.
 */
function positiveOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function rowToDefinition(r: Record<string, unknown>): RoleDefinitionRecord {
  return {
    role_id: r.role_id as string,
    name: (r.name as string) || (r.role_id as string),
    color: (r.color as string) ?? null,
    rank: Number(r.rank ?? 0),
    grantable_by_invite: Number(r.grantable_by_invite ?? 0) === 1,
    permissions: parsePermissions(r.permissions),
    is_system: (r.is_system as number) === 1,
    auto_grant_after_days: positiveOrNull(r.auto_grant_after_days),
    auto_grant_after_messages: positiveOrNull(r.auto_grant_after_messages),
    created_at: fromIso(r.created_at as string),
    updated_at: fromIso(r.updated_at as string),
  };
}

/** Highest rank first, so a list reads top-down like the hierarchy it is. */
export async function listRoleDefinitions(): Promise<RoleDefinitionRecord[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM role_definitions ORDER BY rank DESC, role_id ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToDefinition);
}

export async function getRoleDefinition(
  roleId: string,
): Promise<RoleDefinitionRecord | null> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT * FROM role_definitions WHERE role_id = ?`)
    .get(roleId) as Record<string, unknown> | undefined;
  return row ? rowToDefinition(row) : null;
}

export interface RoleDefinitionInput {
  name: string;
  color?: string | null;
  rank: number;
  grantableByInvite?: boolean;
  permissions: Permission[];
  autoGrantAfterDays?: number | null;
  autoGrantAfterMessages?: number | null;
}

export async function createRoleDefinition(
  roleId: string,
  input: RoleDefinitionInput,
): Promise<RoleDefinitionRecord> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO role_definitions (role_id, name, color, rank, permissions, is_system, auto_grant_after_days, auto_grant_after_messages, created_at, updated_at, grantable_by_invite)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      roleId,
      input.name,
      input.color ?? null,
      input.rank,
      JSON.stringify(normalizePermissions(input.permissions)),
      positiveOrNull(input.autoGrantAfterDays),
      positiveOrNull(input.autoGrantAfterMessages),
      now,
      now,
      input.grantableByInvite ? 1 : 0,
    );

  if (result.changes === 0) throw new Error(`Role "${roleId}" already exists`);

  const created = await getRoleDefinition(roleId);
  if (!created) throw new Error(`Failed to create role "${roleId}"`);
  return created;
}

/**
 * Change a role's name, colour, rank or permissions.
 *
 * `is_system` is not patchable and `role_id` is not renameable — the id is what
 * every `roles` row and both join defaults point at, so renaming it is a
 * migration wearing an edit's clothes. Delete and recreate if you want a
 * different id.
 */
export async function updateRoleDefinition(
  roleId: string,
  patch: Partial<RoleDefinitionInput>,
): Promise<RoleDefinitionRecord | null> {
  const db = getSqliteDb();
  const existing = await getRoleDefinition(roleId);
  if (!existing) return null;

  const next = {
    name: patch.name ?? existing.name,
    color: patch.color === undefined ? existing.color : patch.color,
    rank: patch.rank ?? existing.rank,
    grantableByInvite: patch.grantableByInvite ?? existing.grantable_by_invite,
    permissions: patch.permissions
      ? normalizePermissions(patch.permissions)
      : existing.permissions,
    // `undefined` leaves the threshold where it was; `null` clears it. Without
    // the distinction there is no way to turn an automatic grant back off.
    autoGrantAfterDays:
      patch.autoGrantAfterDays === undefined
        ? existing.auto_grant_after_days
        : positiveOrNull(patch.autoGrantAfterDays),
    autoGrantAfterMessages:
      patch.autoGrantAfterMessages === undefined
        ? existing.auto_grant_after_messages
        : positiveOrNull(patch.autoGrantAfterMessages),
  };

  db.prepare(
    `UPDATE role_definitions SET name = ?, color = ?, rank = ?, permissions = ?, auto_grant_after_days = ?, auto_grant_after_messages = ?, updated_at = ?, grantable_by_invite = ? WHERE role_id = ?`,
  ).run(
    next.name,
    next.color,
    next.rank,
    JSON.stringify(next.permissions),
    next.autoGrantAfterDays,
    next.autoGrantAfterMessages,
    toIso(new Date()),
    next.grantableByInvite ? 1 : 0,
    roleId,
  );

  return getRoleDefinition(roleId);
}

/**
 * How many members hold this role.
 *
 * Asked before a delete so the caller can say what it is about to move, rather
 * than finding out afterwards from a member list that changed shape.
 */
export async function countRoleHolders(roleId: string): Promise<number> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT COUNT(DISTINCT server_user_id) AS cnt FROM roles WHERE role = ?`)
    .get(roleId) as { cnt: number };
  return Number(row?.cnt ?? 0);
}

/** Move everybody holding one role onto another. */
export async function reassignRoleHolders(
  fromRoleId: string,
  toRoleId: string,
): Promise<{ moved: number }> {
  const db = getSqliteDb();
  const now = toIso(new Date());

  // Two statements rather than one UPDATE, because somebody can hold both roles
  // already and the primary key is the pair: renaming one onto the other would
  // fail the whole statement for everybody, and OR REPLACE would drop the
  // created_at of the role they keep. Insert what is missing, then delete what
  // was moved.
  db.exec("BEGIN");
  let moved = 0;
  try {
    db.prepare(
      `INSERT INTO roles (server_user_id, role, created_at, updated_at)
       SELECT server_user_id, ?, created_at, ? FROM roles WHERE role = ?
       ON CONFLICT(server_user_id, role) DO NOTHING`,
    ).run(toRoleId, now, fromRoleId);

    const removed = db.prepare(`DELETE FROM roles WHERE role = ?`).run(fromRoleId);
    moved = Number(removed.changes ?? 0);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { moved };
}

/**
 * Delete a role, moving whoever held it onto `reassignTo` first. A dangling id
 * already resolves to the fallback on read, but leaving one has the member list
 * and the role editor disagree about what somebody is.
 *
 * System roles are refused: the seeder would put the row back on the next
 * restart, so allowing it is a delete that silently undoes itself.
 */
export async function deleteRoleDefinition(
  roleId: string,
  reassignTo: string,
): Promise<{ deleted: boolean; moved: number }> {
  if (isSystemRole(roleId)) return { deleted: false, moved: 0 };

  const db = getSqliteDb();
  const { moved } = await reassignRoleHolders(roleId, reassignTo);
  const result = db
    .prepare(`DELETE FROM role_definitions WHERE role_id = ? AND is_system = 0`)
    .run(roleId);

  return { deleted: Number(result.changes ?? 0) > 0, moved };
}

/**
 * The rank a role id carries, for the outranks checks.
 *
 * An id with no definition behind it — a role deleted out from under a `roles`
 * row — reads as rank 0, which loses every comparison. That is the fail-shut
 * direction for a caller asking "may this person act on that one".
 */
export async function getRoleRank(roleId: string): Promise<number> {
  const def = await getRoleDefinition(roleId);
  if (def) return def.rank;
  const builtIn = BUILT_IN_ROLES.find((r) => r.id === roleId);
  return builtIn?.rank ?? 0;
}
