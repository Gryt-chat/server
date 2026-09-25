import type { DatabaseSync } from "node:sqlite";

import { getSqliteDb, toIso } from "./connection";

/**
 * Friends between members of this server, and requests still waiting (GRYT-1471).
 * Gryt ids like blocks, so both outlast leaving and rejoining.
 */

/** A request nobody answers is gone after this long. */
export const FRIEND_REQUEST_TTL_MS = 30 * 24 * 60 * 60_000;

export interface FriendPerson {
  grytUserId: string;
  /** Null when their member row is gone. */
  serverUserId: string | null;
  nickname: string | null;
  /** When the friendship, or the request, was made. */
  at: string;
}

export interface FriendRequests {
  /** Ignored ones are left out: ignoring is only the recipient's business. */
  incoming: FriendPerson[];
  outgoing: FriendPerson[];
}

/** The smaller id first, so each pair has exactly one row. */
function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function cutoff(now = Date.now()): string {
  return toIso(new Date(now - FRIEND_REQUEST_TTL_MS));
}

type PersonRow = { gryt_user_id: string; server_user_id: string | null; nickname: string | null; at: string };

const toPerson = (r: PersonRow): FriendPerson => ({
  grytUserId: r.gryt_user_id,
  serverUserId: r.server_user_id,
  nickname: r.nickname,
  at: r.at,
});

export async function areFriends(a: string, b: string): Promise<boolean> {
  const [x, y] = ordered(a, b);
  return !!getSqliteDb()
    .prepare(`SELECT 1 FROM friendships WHERE a_gryt_user_id = ? AND b_gryt_user_id = ?`)
    .get(x, y);
}

export async function hasAnyFriend(grytUserId: string): Promise<boolean> {
  return !!getSqliteDb()
    .prepare(`SELECT 1 FROM friendships WHERE a_gryt_user_id = ? OR b_gryt_user_id = ? LIMIT 1`)
    .get(grytUserId, grytUserId);
}

export async function listFriends(grytUserId: string): Promise<FriendPerson[]> {
  const rows = getSqliteDb()
    .prepare(
      `SELECT f.other AS gryt_user_id, u.server_user_id, u.nickname, f.created_at AS at
         FROM (SELECT CASE WHEN a_gryt_user_id = ? THEN b_gryt_user_id ELSE a_gryt_user_id END AS other, created_at
                 FROM friendships WHERE a_gryt_user_id = ? OR b_gryt_user_id = ?) f
         LEFT JOIN users u ON u.gryt_user_id = f.other
        ORDER BY f.created_at`,
    )
    .all(grytUserId, grytUserId, grytUserId) as PersonRow[];
  return rows.map(toPerson);
}

export async function getFriendRequest(from: string, to: string): Promise<{ ignored: boolean } | null> {
  const row = getSqliteDb()
    .prepare(`SELECT ignored FROM friend_requests WHERE from_gryt_user_id = ? AND to_gryt_user_id = ? AND created_at > ?`)
    .get(from, to, cutoff()) as { ignored: number } | undefined;
  return row ? { ignored: row.ignored === 1 } : null;
}

/** True when a new request was stored. One already waiting stays as it was, ignored included. */
export async function putFriendRequest(from: string, to: string): Promise<boolean> {
  const db = getSqliteDb();
  db.prepare(`DELETE FROM friend_requests WHERE created_at <= ?`).run(cutoff());
  return db
    .prepare(`INSERT OR IGNORE INTO friend_requests (from_gryt_user_id, to_gryt_user_id, ignored, created_at) VALUES (?, ?, 0, ?)`)
    .run(from, to, toIso(new Date())).changes > 0;
}

export async function deleteFriendRequest(from: string, to: string): Promise<boolean> {
  return getSqliteDb()
    .prepare(`DELETE FROM friend_requests WHERE from_gryt_user_id = ? AND to_gryt_user_id = ?`)
    .run(from, to).changes > 0;
}

/** Declining hides it from the recipient and tells the sender nothing. */
export async function ignoreFriendRequest(from: string, to: string): Promise<boolean> {
  return getSqliteDb()
    .prepare(`UPDATE friend_requests SET ignored = 1 WHERE from_gryt_user_id = ? AND to_gryt_user_id = ?`)
    .run(from, to).changes > 0;
}

export async function countOutgoingFriendRequests(grytUserId: string): Promise<number> {
  const row = getSqliteDb()
    .prepare(`SELECT COUNT(*) AS n FROM friend_requests WHERE from_gryt_user_id = ? AND created_at > ?`)
    .get(grytUserId, cutoff()) as { n: number };
  return row.n;
}

export async function listFriendRequests(grytUserId: string): Promise<FriendRequests> {
  const db = getSqliteDb();
  const since = cutoff();
  const incoming = db
    .prepare(
      `SELECT r.from_gryt_user_id AS gryt_user_id, u.server_user_id, u.nickname, r.created_at AS at
         FROM friend_requests r LEFT JOIN users u ON u.gryt_user_id = r.from_gryt_user_id
        WHERE r.to_gryt_user_id = ? AND r.ignored = 0 AND r.created_at > ?
        ORDER BY r.created_at`,
    )
    .all(grytUserId, since) as PersonRow[];
  const outgoing = db
    .prepare(
      `SELECT r.to_gryt_user_id AS gryt_user_id, u.server_user_id, u.nickname, r.created_at AS at
         FROM friend_requests r LEFT JOIN users u ON u.gryt_user_id = r.to_gryt_user_id
        WHERE r.from_gryt_user_id = ? AND r.created_at > ?
        ORDER BY r.created_at`,
    )
    .all(grytUserId, since) as PersonRow[];
  return { incoming: incoming.map(toPerson), outgoing: outgoing.map(toPerson) };
}

/** The pair, and whatever requests led to it, in one go. */
export async function makeFriends(a: string, b: string): Promise<void> {
  const db = getSqliteDb();
  const [x, y] = ordered(a, b);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO friendships (a_gryt_user_id, b_gryt_user_id, created_at) VALUES (?, ?, ?)`)
      .run(x, y, toIso(new Date()));
    dropRequestsBetween(db, a, b);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export async function unfriend(a: string, b: string): Promise<boolean> {
  const [x, y] = ordered(a, b);
  return getSqliteDb()
    .prepare(`DELETE FROM friendships WHERE a_gryt_user_id = ? AND b_gryt_user_id = ?`)
    .run(x, y).changes > 0;
}

/** A block ends the friendship and any request either way. */
export async function forgetFriendship(a: string, b: string): Promise<void> {
  await unfriend(a, b);
  dropRequestsBetween(getSqliteDb(), a, b);
}

function dropRequestsBetween(db: DatabaseSync, a: string, b: string): void {
  db.prepare(
    `DELETE FROM friend_requests
      WHERE (from_gryt_user_id = ? AND to_gryt_user_id = ?) OR (from_gryt_user_id = ? AND to_gryt_user_id = ?)`,
  ).run(a, b, b, a);
}

/** Inside the caller's transaction, like carryBlocksForward. A pair or request
    between the two ids would be with yourself, and goes. */
export function carryFriendsForward(db: DatabaseSync, from: string, to: string): void {
  const pairs = db
    .prepare(`SELECT a_gryt_user_id AS a, b_gryt_user_id AS b, created_at FROM friendships WHERE a_gryt_user_id = ? OR b_gryt_user_id = ?`)
    .all(from, from) as { a: string; b: string; created_at: string }[];
  const insertPair = db.prepare(`INSERT OR IGNORE INTO friendships (a_gryt_user_id, b_gryt_user_id, created_at) VALUES (?, ?, ?)`);
  for (const p of pairs) {
    const other = p.a === from ? p.b : p.a;
    if (other === to) continue;
    const [x, y] = ordered(to, other);
    insertPair.run(x, y, p.created_at);
  }
  db.prepare(`DELETE FROM friendships WHERE a_gryt_user_id = ? OR b_gryt_user_id = ?`).run(from, from);

  db.prepare(
    `INSERT OR IGNORE INTO friend_requests (from_gryt_user_id, to_gryt_user_id, ignored, created_at)
     SELECT ?, to_gryt_user_id, ignored, created_at FROM friend_requests WHERE from_gryt_user_id = ? AND to_gryt_user_id <> ?`,
  ).run(to, from, to);
  db.prepare(
    `INSERT OR IGNORE INTO friend_requests (from_gryt_user_id, to_gryt_user_id, ignored, created_at)
     SELECT from_gryt_user_id, ?, ignored, created_at FROM friend_requests WHERE to_gryt_user_id = ? AND from_gryt_user_id <> ?`,
  ).run(to, from, to);
  db.prepare(`DELETE FROM friend_requests WHERE from_gryt_user_id = ? OR to_gryt_user_id = ?`).run(from, from);
}
