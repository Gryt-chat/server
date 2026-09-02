import { randomUUID } from "crypto";

import type { UserReportRecord } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

/**
 * Reports about a person, as opposed to `reports.ts`, which is about messages.
 *
 * Filtering happens in SQL here rather than by pulling every pending row and
 * scanning it in JavaScript, which is what the message queue next door does.
 * Both are correct at the sizes either sees; this one is simply new enough to
 * have been written the other way.
 */

function rowToUserReport(r: Record<string, unknown>): UserReportRecord {
  return {
    report_id: r.report_id as string,
    reported_server_user_id: r.reported_server_user_id as string,
    reported_nickname: (r.reported_nickname as string) ?? null,
    reporter_server_user_id: r.reporter_server_user_id as string,
    reporter_nickname: (r.reporter_nickname as string) ?? null,
    reason: r.reason as string,
    status: (r.status as UserReportRecord["status"]) ?? "pending",
    resolved_by_server_user_id: (r.resolved_by_server_user_id as string) ?? null,
    created_at: fromIso(r.created_at as string),
    resolved_at: fromIsoNullable(r.resolved_at as string | null),
  };
}

export async function insertUserReport(record: {
  reported_server_user_id: string;
  reported_nickname: string | null;
  reporter_server_user_id: string;
  reporter_nickname: string | null;
  reason: string;
}): Promise<UserReportRecord> {
  const db = getSqliteDb();
  const report_id = randomUUID();
  const created_at = new Date();
  db.prepare(
    `INSERT INTO user_reports (report_id, reported_server_user_id, reported_nickname, reporter_server_user_id, reporter_nickname, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    report_id,
    record.reported_server_user_id,
    record.reported_nickname,
    record.reporter_server_user_id,
    record.reporter_nickname,
    record.reason,
    toIso(created_at),
  );
  return {
    report_id,
    created_at,
    status: "pending",
    resolved_by_server_user_id: null,
    resolved_at: null,
    ...record,
  };
}

/**
 * Whether this reporter already has an open report about this person.
 *
 * Pending only, deliberately. Somebody whose first report was dismissed and who
 * is being harassed again has something new to say, and refusing them would
 * mean a dismissal silences the reporter permanently.
 */
export async function hasUserReportedUser(
  reportedServerUserId: string,
  reporterServerUserId: string,
): Promise<boolean> {
  const db = getSqliteDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_reports WHERE status = 'pending' AND reported_server_user_id = ? AND reporter_server_user_id = ? LIMIT 1`,
    )
    .get(reportedServerUserId, reporterServerUserId);
  return !!row;
}

export interface AggregatedUserReport {
  reported_server_user_id: string;
  reported_nickname: string | null;
  report_count: number;
  reporters: string[];
  reasons: Array<{
    reporter_server_user_id: string;
    reporter_nickname: string | null;
    reason: string;
    created_at: Date;
  }>;
  first_reported_at: Date;
  report_ids: string[];
}

/**
 * The pending queue, one row per person reported.
 *
 * Ordered by how many distinct people reported them, then by how long the
 * oldest has been waiting — the same ordering the message queue uses, so a
 * moderator reading both lists reads them the same way.
 */
export async function getAggregatedPendingUserReports(): Promise<AggregatedUserReport[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM user_reports WHERE status = 'pending' ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];

  const byUser = new Map<string, AggregatedUserReport & { reporterSet: Set<string> }>();
  for (const raw of rows) {
    const r = rowToUserReport(raw);
    let entry = byUser.get(r.reported_server_user_id);
    if (!entry) {
      entry = {
        reported_server_user_id: r.reported_server_user_id,
        reported_nickname: r.reported_nickname,
        report_count: 0,
        reporters: [],
        reasons: [],
        first_reported_at: r.created_at,
        report_ids: [],
        reporterSet: new Set<string>(),
      };
      byUser.set(r.reported_server_user_id, entry);
    }
    /* The newest nickname wins. Rows arrive oldest first, so a person who has
     * renamed themselves since the first report is listed under the name a
     * moderator will actually find in the member list. */
    if (r.reported_nickname) entry.reported_nickname = r.reported_nickname;
    entry.reporterSet.add(r.reporter_server_user_id);
    entry.report_ids.push(r.report_id);
    entry.reasons.push({
      reporter_server_user_id: r.reporter_server_user_id,
      reporter_nickname: r.reporter_nickname,
      reason: r.reason,
      created_at: r.created_at,
    });
    if (r.created_at < entry.first_reported_at) entry.first_reported_at = r.created_at;
  }

  return [...byUser.values()]
    .map(({ reporterSet, ...rest }) => ({
      ...rest,
      report_count: reporterSet.size,
      reporters: [...reporterSet],
    }))
    .sort(
      (a, b) =>
        b.report_count - a.report_count ||
        a.first_reported_at.getTime() - b.first_reported_at.getTime(),
    );
}

/**
 * Close every open report about one person in a single write.
 *
 * There is no per-report resolution on purpose. The queue shows one card per
 * person, so acting on that card has to close everything behind it — leaving
 * some open would put the same person straight back in the queue with a
 * smaller count.
 */
export async function resolveUserReportsFor(
  reportedServerUserId: string,
  resolution: "dismissed" | "actioned",
  resolvedByServerUserId: string,
): Promise<number> {
  const db = getSqliteDb();
  const result = db
    .prepare(
      `UPDATE user_reports SET status = ?, resolved_by_server_user_id = ?, resolved_at = ? WHERE reported_server_user_id = ? AND status = 'pending'`,
    )
    .run(resolution, resolvedByServerUserId, toIso(new Date()), reportedServerUserId);
  return Number(result.changes);
}

export async function listUserReports(
  statusFilter?: UserReportRecord["status"],
  limit = 100,
): Promise<UserReportRecord[]> {
  const db = getSqliteDb();
  const rows = statusFilter
    ? (db
        .prepare(`SELECT * FROM user_reports WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(statusFilter, limit) as Record<string, unknown>[])
    : (db
        .prepare(`SELECT * FROM user_reports ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]);
  return rows.map(rowToUserReport);
}
