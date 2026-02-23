import { randomUUID } from "crypto";
import { getScyllaClient } from "./scylla";

export interface ReportRecord {
  report_id: string;
  message_id: string;
  conversation_id: string;
  reporter_server_user_id: string;
  message_text: string | null;
  message_attachments: string[] | null;
  message_sender_server_id: string;
  message_sender_nickname: string | null;
  status: "pending" | "approved" | "deleted";
  resolved_by_server_user_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export async function insertReport(record: {
  message_id: string;
  conversation_id: string;
  reporter_server_user_id: string;
  message_text: string | null;
  message_attachments: string[] | null;
  message_sender_server_id: string;
  message_sender_nickname: string | null;
}): Promise<ReportRecord> {
  const c = getScyllaClient();
  const report_id = randomUUID();
  const created_at = new Date();

  await c.execute(
    `INSERT INTO message_reports (bucket, created_at, report_id, message_id, conversation_id, reporter_server_user_id, message_text, message_attachments, message_sender_server_id, message_sender_nickname, status, resolved_by_server_user_id, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["reports", created_at, report_id, record.message_id, record.conversation_id, record.reporter_server_user_id, record.message_text, record.message_attachments, record.message_sender_server_id, record.message_sender_nickname, "pending", null, null],
    { prepare: true },
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

export async function listReports(statusFilter?: string, limit = 100): Promise<ReportRecord[]> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT report_id, message_id, conversation_id, reporter_server_user_id, message_text, message_attachments, message_sender_server_id, message_sender_nickname, status, resolved_by_server_user_id, created_at, resolved_at FROM message_reports WHERE bucket = ? ORDER BY created_at DESC, report_id DESC LIMIT ?`,
    ["reports", limit],
    { prepare: true },
  );

  const reports: ReportRecord[] = rs.rows.map((r) => ({
    report_id: r["report_id"]?.toString(),
    message_id: r["message_id"],
    conversation_id: r["conversation_id"],
    reporter_server_user_id: r["reporter_server_user_id"],
    message_text: r["message_text"] ?? null,
    message_attachments: r["message_attachments"] ?? null,
    message_sender_server_id: r["message_sender_server_id"],
    message_sender_nickname: r["message_sender_nickname"] ?? null,
    status: r["status"] ?? "pending",
    resolved_by_server_user_id: r["resolved_by_server_user_id"] ?? null,
    created_at: r["created_at"],
    resolved_at: r["resolved_at"] ?? null,
  }));

  if (statusFilter) {
    return reports.filter((r) => r.status === statusFilter);
  }
  return reports;
}

export async function resolveReport(
  reportId: string,
  resolution: "approved" | "deleted",
  resolvedByServerUserId: string,
): Promise<boolean> {
  const c = getScyllaClient();
  const now = new Date();

  const rs = await c.execute(
    `SELECT created_at FROM message_reports WHERE bucket = ? AND report_id = ? ALLOW FILTERING`,
    ["reports", reportId],
    { prepare: true },
  );
  const row = rs.first();
  if (!row) return false;

  await c.execute(
    `UPDATE message_reports SET status = ?, resolved_by_server_user_id = ?, resolved_at = ? WHERE bucket = ? AND created_at = ? AND report_id = ?`,
    [resolution, resolvedByServerUserId, now, "reports", row["created_at"], reportId],
    { prepare: true },
  );
  return true;
}

export async function resolveAllReportsForMessage(
  messageId: string,
  resolution: "approved" | "deleted",
  resolvedByServerUserId: string,
): Promise<number> {
  const pending = await listReports("pending");
  const matching = pending.filter((r) => r.message_id === messageId);
  let resolved = 0;
  for (const r of matching) {
    const ok = await resolveReport(r.report_id, resolution, resolvedByServerUserId);
    if (ok) resolved++;
  }
  return resolved;
}

export async function hasUserReportedMessage(
  messageId: string,
  reporterServerUserId: string,
): Promise<boolean> {
  const reports = await listReports("pending");
  return reports.some(
    (r) => r.message_id === messageId && r.reporter_server_user_id === reporterServerUserId,
  );
}

export async function getReportCountForMessage(messageId: string): Promise<number> {
  const reports = await listReports("pending");
  const uniqueReporters = new Set(
    reports.filter((r) => r.message_id === messageId).map((r) => r.reporter_server_user_id),
  );
  return uniqueReporters.size;
}

/**
 * Aggregate pending reports by message, returning unique messages
 * with report count and reporter list.
 */
export async function getAggregatedPendingReports(): Promise<
  Array<{
    message_id: string;
    conversation_id: string;
    message_text: string | null;
    message_attachments: string[] | null;
    message_sender_server_id: string;
    message_sender_nickname: string | null;
    report_count: number;
    reporters: string[];
    first_reported_at: Date;
    report_ids: string[];
  }>
> {
  const pending = await listReports("pending");
  const byMessage = new Map<
    string,
    {
      message_id: string;
      conversation_id: string;
      message_text: string | null;
      message_attachments: string[] | null;
      message_sender_server_id: string;
      message_sender_nickname: string | null;
      reporters: Set<string>;
      first_reported_at: Date;
      report_ids: string[];
    }
  >();

  for (const r of pending) {
    const existing = byMessage.get(r.message_id);
    if (existing) {
      existing.reporters.add(r.reporter_server_user_id);
      existing.report_ids.push(r.report_id);
      if (r.created_at < existing.first_reported_at) {
        existing.first_reported_at = r.created_at;
      }
    } else {
      byMessage.set(r.message_id, {
        message_id: r.message_id,
        conversation_id: r.conversation_id,
        message_text: r.message_text,
        message_attachments: r.message_attachments,
        message_sender_server_id: r.message_sender_server_id,
        message_sender_nickname: r.message_sender_nickname,
        reporters: new Set([r.reporter_server_user_id]),
        first_reported_at: r.created_at,
        report_ids: [r.report_id],
      });
    }
  }

  return [...byMessage.values()]
    .map((v) => ({
      ...v,
      report_count: v.reporters.size,
      reporters: [...v.reporters],
    }))
    .sort((a, b) => b.report_count - a.report_count || b.first_reported_at.getTime() - a.first_reported_at.getTime());
}

/**
 * Delete all messages from a specific user across all conversations.
 * Returns the list of { conversation_id, message_id } pairs deleted.
 */
export async function deleteAllMessagesByUser(
  senderServerUserId: string,
): Promise<Array<{ conversation_id: string; message_id: string }>> {
  const c = getScyllaClient();
  const deleted: Array<{ conversation_id: string; message_id: string }> = [];

  const rs = await c.execute(
    `SELECT conversation_id, created_at, message_id, sender_server_id FROM messages_by_conversation`,
    [],
    { prepare: true, fetchSize: 5000 },
  );

  for (const row of rs.rows) {
    if (row["sender_server_id"] === senderServerUserId) {
      await c.execute(
        `DELETE FROM messages_by_conversation WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
        [row["conversation_id"], row["created_at"], row["message_id"]],
        { prepare: true },
      );
      deleted.push({
        conversation_id: row["conversation_id"],
        message_id: row["message_id"]?.toString(),
      });
    }
  }

  return deleted;
}
