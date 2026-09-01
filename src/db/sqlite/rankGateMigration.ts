import type { DatabaseSync } from "node:sqlite";

/**
 * Turn the two rank columns into permission scopes, once.
 *
 * `post_min_rank` and `view_min_rank` said "rank N and above". Scopes say
 * "these roles, this permission, allow or deny", which can express the same
 * thing and a good deal more — so the rank columns go, and what somebody
 * already configured has to survive the change without them having to redo it.
 *
 * The translation is exact rather than approximate. A gate at 60 denies the
 * permission to every role below 60 and says nothing about the rest, which is
 * precisely what the rank compare did. Roles at or above the gate get no row,
 * so they inherit, which is also what the compare did.
 *
 * ## Why the columns are not dropped
 *
 * SQLite could drop them. If it did, a server rolled back to a build that still
 * reads `post_min_rank` would find it NULL and quietly reopen a channel that
 * was meant to be locked. Leaving the value in place means a rollback still
 * enforces the gate it had. Nothing on this side reads them after this runs.
 *
 * ## Why it runs once
 *
 * The marker is the whole safety property. Run it twice and the second pass
 * sees the same rank values and rebuilds scopes for channels whose permissions
 * somebody has since edited by hand, throwing that away. So it checks
 * `schema_meta` first and writes the marker inside the same transaction.
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

/**
 * The rules one channel's gates become.
 *
 * Exported for the test, which checks the translation on its own rather than
 * through a database — the arithmetic is the part worth pinning, and it reads
 * as a table of cases when it is not wrapped in schema.
 */
export function rulesForRankGates(
  roles: RoleRow[],
  postMinRank: number | null,
  viewMinRank: number | null,
): { roleId: string; permission: string; effect: "deny" }[] {
  const rules: { roleId: string; permission: string; effect: "deny" }[] = [];

  for (const role of roles) {
    // Reading first: a role that cannot see the channel has no use for the
    // right to post in it, but both rows are written anyway. The gates were
    // independent, and folding them together here would mean a later edit that
    // restores reading silently restores posting with it.
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

      // A private scope, not a template. Two channels that happened to share a
      // rank did not share a setting — they had the same number — and turning
      // that into one template would link them, so editing one would silently
      // change the other. Somebody who wants them linked can make a template.
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

    // Inside the transaction. Written outside it, a crash between the two would
    // leave the marker set against work that rolled back, and the gates would
    // be gone with nothing to replace them.
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
