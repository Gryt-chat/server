import type { ServerJoinRequestRecord } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

const NOTE_MAX = 300;

function rowToJoinRequest(r: Record<string, unknown>): ServerJoinRequestRecord {
  return {
    gryt_user_id: r.gryt_user_id as string,
    nickname: (r.nickname as string) ?? "",
    note: (r.note as string) ?? null,
    status: normalizeStatus(r.status),
    created_at: fromIso(r.created_at as string),
    decided_at: fromIsoNullable(r.decided_at as string | null),
    decided_by_server_user_id: (r.decided_by_server_user_id as string) ?? null,
  };
}

/**
 * Anything unrecognised reads as `pending`, never as `approved`.
 *
 * Same reasoning as normalizeJoinPolicy: a row written by a newer server, or
 * edited by hand, must leave somebody outside the door rather than inside it.
 */
export function normalizeStatus(v: unknown): ServerJoinRequestRecord["status"] {
  const s = String(v || "").toLowerCase();
  if (s === "approved" || s === "denied") return s;
  return "pending";
}

export function normalizeNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().slice(0, NOTE_MAX);
  return trimmed.length > 0 ? trimmed : null;
}

export async function getJoinRequest(grytUserId: string): Promise<ServerJoinRequestRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM join_requests WHERE gryt_user_id = ?`).get(grytUserId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToJoinRequest(row) : null;
}

export async function listJoinRequests(status?: ServerJoinRequestRecord["status"]): Promise<ServerJoinRequestRecord[]> {
  const db = getSqliteDb();
  const rows = status
    ? db.prepare(`SELECT * FROM join_requests WHERE status = ? ORDER BY created_at ASC`).all(status)
    : db.prepare(`SELECT * FROM join_requests ORDER BY created_at ASC`).all();
  return (rows as Record<string, unknown>[]).map(rowToJoinRequest);
}

/**
 * Records somebody asking to be let in, or refreshes what they are asking with.
 *
 * Returns the row as it now stands, so the caller can tell an approval from a
 * fresh ask without a second read. A decided request is returned untouched:
 * re-asking must not wipe a denial, and must not reset an approval that is
 * waiting to be used.
 */
export async function createOrRefreshJoinRequest(
  grytUserId: string,
  nickname: string,
  note?: string | null,
): Promise<ServerJoinRequestRecord> {
  const db = getSqliteDb();
  const existing = await getJoinRequest(grytUserId);
  if (existing && existing.status !== "pending") return existing;

  const now = new Date();
  const cleanNickname = String(nickname || "User").trim().slice(0, 50);
  const cleanNote = normalizeNote(note);

  if (existing) {
    // Still pending. Keep the original created_at so the queue stays in the
    // order people actually arrived — otherwise reconnecting repeatedly is a
    // way to jump it.
    db.prepare(
      `UPDATE join_requests SET nickname = ?, note = COALESCE(?, note) WHERE gryt_user_id = ?`,
    ).run(cleanNickname, cleanNote, grytUserId);
    return (await getJoinRequest(grytUserId)) as ServerJoinRequestRecord;
  }

  db.prepare(
    `INSERT INTO join_requests (gryt_user_id, nickname, note, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
  ).run(grytUserId, cleanNickname, cleanNote, toIso(now));

  return {
    gryt_user_id: grytUserId,
    nickname: cleanNickname,
    note: cleanNote,
    status: "pending",
    created_at: now,
    decided_at: null,
    decided_by_server_user_id: null,
  };
}

export async function decideJoinRequest(
  grytUserId: string,
  decision: "approved" | "denied",
  decidedByServerUserId: string | null,
): Promise<ServerJoinRequestRecord | null> {
  const db = getSqliteDb();
  const existing = await getJoinRequest(grytUserId);
  if (!existing) return null;
  db.prepare(
    `UPDATE join_requests SET status = ?, decided_at = ?, decided_by_server_user_id = ? WHERE gryt_user_id = ?`,
  ).run(decision, toIso(new Date()), decidedByServerUserId, grytUserId);
  return await getJoinRequest(grytUserId);
}

/**
 * Called once the approved person has actually joined.
 *
 * The row goes rather than being left as `approved`, so that leaving the server
 * later puts somebody back at the door instead of letting a years-old approval
 * readmit them.
 */
export async function clearJoinRequest(grytUserId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`DELETE FROM join_requests WHERE gryt_user_id = ?`).run(grytUserId);
}
