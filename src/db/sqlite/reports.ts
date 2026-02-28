import { randomUUID } from "crypto";

import type { ReportRecord } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

function rowToReport(r: Record<string, unknown>): ReportRecord {
  return {
    report_id: r.report_id as string, message_id: r.message_id as string, conversation_id: r.conversation_id as string,
    reporter_server_user_id: r.reporter_server_user_id as string, message_text: (r.message_text as string) ?? null,
    message_attachments: r.message_attachments ? JSON.parse(r.message_attachments as string) : null,
    message_sender_server_id: r.message_sender_server_id as string, message_sender_nickname: (r.message_sender_nickname as string) ?? null,
    status: (r.status as "pending" | "approved" | "deleted") ?? "pending",
    resolved_by_server_user_id: (r.resolved_by_server_user_id as string) ?? null,
    created_at: fromIso(r.created_at as string), resolved_at: fromIsoNullable(r.resolved_at as string | null),
  };
}

export async function insertReport(record: {
  message_id: string; conversation_id: string; reporter_server_user_id: string; message_text: string | null;
  message_attachments: string[] | null; message_sender_server_id: string; message_sender_nickname: string | null;
}): Promise<ReportRecord> {
  const db = getSqliteDb();
  const report_id = randomUUID();
  const created_at = new Date();
  db.prepare(
    `INSERT INTO reports (report_id, message_id, conversation_id, reporter_server_user_id, message_text, message_attachments, message_sender_server_id, message_sender_nickname, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(report_id, record.message_id, record.conversation_id, record.reporter_server_user_id, record.message_text,
    record.message_attachments ? JSON.stringify(record.message_attachments) : null,
    record.message_sender_server_id, record.message_sender_nickname, toIso(created_at));
  return { report_id, created_at, status: "pending", resolved_by_server_user_id: null, resolved_at: null, ...record };
}

export async function listReports(statusFilter?: string, limit = 100): Promise<ReportRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  const reports = rows.map(rowToReport);
  return statusFilter ? reports.filter((r) => r.status === statusFilter) : reports;
}

export async function resolveReport(reportId: string, resolution: "approved" | "deleted", resolvedByServerUserId: string): Promise<boolean> {
  const db = getSqliteDb();
  const now = toIso(new Date());
  const result = db.prepare(`UPDATE reports SET status = ?, resolved_by_server_user_id = ?, resolved_at = ? WHERE report_id = ?`).run(resolution, resolvedByServerUserId, now, reportId);
  return result.changes > 0;
}

export async function resolveAllReportsForMessage(messageId: string, resolution: "approved" | "deleted", resolvedByServerUserId: string): Promise<number> {
  const pending = await listReports("pending");
  const matching = pending.filter((r) => r.message_id === messageId);
  let resolved = 0;
  for (const r of matching) { if (await resolveReport(r.report_id, resolution, resolvedByServerUserId)) resolved++; }
  return resolved;
}

export async function hasUserReportedMessage(messageId: string, reporterServerUserId: string): Promise<boolean> {
  const reports = await listReports("pending");
  return reports.some((r) => r.message_id === messageId && r.reporter_server_user_id === reporterServerUserId);
}

export async function getReportCountForMessage(messageId: string): Promise<number> {
  const reports = await listReports("pending");
  return new Set(reports.filter((r) => r.message_id === messageId).map((r) => r.reporter_server_user_id)).size;
}

export async function getAggregatedPendingReports(): Promise<
  Array<{ message_id: string; conversation_id: string; message_text: string | null; message_attachments: string[] | null;
    message_sender_server_id: string; message_sender_nickname: string | null; report_count: number; reporters: string[]; first_reported_at: Date; report_ids: string[]; }>
> {
  const pending = await listReports("pending");
  const byMessage = new Map<string, { message_id: string; conversation_id: string; message_text: string | null; message_attachments: string[] | null;
    message_sender_server_id: string; message_sender_nickname: string | null; reporters: Set<string>; first_reported_at: Date; report_ids: string[]; }>();
  for (const r of pending) {
    const ex = byMessage.get(r.message_id);
    if (ex) { ex.reporters.add(r.reporter_server_user_id); ex.report_ids.push(r.report_id); if (r.created_at < ex.first_reported_at) ex.first_reported_at = r.created_at; }
    else { byMessage.set(r.message_id, { message_id: r.message_id, conversation_id: r.conversation_id, message_text: r.message_text, message_attachments: r.message_attachments, message_sender_server_id: r.message_sender_server_id, message_sender_nickname: r.message_sender_nickname, reporters: new Set([r.reporter_server_user_id]), first_reported_at: r.created_at, report_ids: [r.report_id] }); }
  }
  return [...byMessage.values()].map((v) => ({ ...v, report_count: v.reporters.size, reporters: [...v.reporters] }))
    .sort((a, b) => b.report_count - a.report_count || b.first_reported_at.getTime() - a.first_reported_at.getTime());
}

export async function deleteAllMessagesByUser(senderServerUserId: string): Promise<Array<{ conversation_id: string; message_id: string }>> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT conversation_id, message_id FROM messages WHERE sender_server_id = ?`).all(senderServerUserId) as { conversation_id: string; message_id: string }[];
  db.prepare(`DELETE FROM messages WHERE sender_server_id = ?`).run(senderServerUserId);
  return rows;
}
