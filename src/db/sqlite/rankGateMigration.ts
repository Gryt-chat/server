import type { DatabaseSync } from "node:sqlite";

/**
 * A gate at 60 denies every role below it and leaves the rest inheriting. The
 * columns are not dropped, or a rollback finds NULL and reopens the channel, and
 * the marker is written in the same transaction so a second pass cannot run.
 */

export const RANK_GATE_MIGRATION_KEY = "channel_rank_gates_migrated";

interface RoleRow {
  role_id: string;
  rank: number;
}

interface ChannelRow {
  channel_id: string;
  post_min_rank: number | null;
  view_min_rank: number | null;
  permission_scope_id: string | null;
}

/** Exported for the test, which checks the translation without a database: the
    arithmetic is the part worth pinning. */
export function rulesForRankGates(
  roles: RoleRow[],
  postMinRank: number | null,
  viewMinRank: number | null,
): { roleId: string; permission: string; effect: "deny" }[] {
  const rules: { roleId: string; permission: string; effect: "deny" }[] = [];

  for (const role of roles) {
    // Both rows are written even though one implies the other: the gates were
    // independent, and folding them makes restoring reading restore posting.
    if (viewMinRank != null && role.rank < viewMinRank) {
      rules.push({ roleId: role.role_id, permission: "read_messages", effect: "deny" });
    }
    if (postMinRank != null && role.rank < postMinRank) {
      rules.push({ roleId: role.role_id, permission: "send_messages", effect: "deny" });
    }
  }

  return rules;
}

/** How many channels were converted. Zero on a server that used neither gate. */
export function migrateRankGatesToScopes(d: DatabaseSync): number {
  const already = d.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(RANK_GATE_MIGRATION_KEY) as
    | { value: string }
    | undefined;
  if (already) return 0;

  const channels = d
    .prepare(
      `SELECT channel_id, post_min_rank, view_min_rank, permission_scope_id
       FROM channels
       WHERE post_min_rank IS NOT NULL OR view_min_rank IS NOT NULL`,
    )
    .all() as unknown as ChannelRow[];

  const roles = d.prepare(`SELECT role_id, rank FROM role_definitions`).all() as unknown as RoleRow[];

  const now = new Date().toISOString();
  let converted = 0;

  d.exec("BEGIN");
  try {
    for (const channel of channels) {
      // A channel that already points somewhere has been configured on the new
      // model. Its rank columns are leftovers and the scope is the truth.
      if (channel.permission_scope_id) continue;

      const rules = rulesForRankGates(roles, channel.post_min_rank, channel.view_min_rank);
      if (rules.length === 0) continue;

      // Private, not a template: two channels sharing a rank had the same number
      // rather than the same setting, and a template would link them.
      const scopeId = `scope_migrated_${channel.channel_id}`.slice(0, 64);
      d.prepare(
        `INSERT OR REPLACE INTO channel_permission_scopes
           (scope_id, name, is_template, is_system, created_at, updated_at)
         VALUES (?, NULL, 0, 0, ?, ?)`,
      ).run(scopeId, now, now);

      const insert = d.prepare(
        `INSERT OR REPLACE INTO channel_permission_rules
           (scope_id, role_id, permission, effect, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const rule of rules) insert.run(scopeId, rule.roleId, rule.permission, rule.effect, now);

      d.prepare(`UPDATE channels SET permission_scope_id = ?, updated_at = ? WHERE channel_id = ?`)
        .run(scopeId, now, channel.channel_id);
      converted += 1;
    }

    // Inside the transaction: outside it, a crash leaves the marker set against
    // work that rolled back and the gates gone.
    d.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
    ).run(RANK_GATE_MIGRATION_KEY, now, now);

    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }

  return converted;
}
