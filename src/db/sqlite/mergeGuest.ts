import type { DatabaseSync } from "node:sqlite";

import type { Reaction } from "../interfaces";
import { getSqliteDb, toIso } from "./connection";

export interface GuestMerge {
  guestServerUserId: string;
  accountServerUserId: string;
  ownerMoved: boolean;
  /** Where the guest was a member, so everybody in them can be sent the new view. */
  conversationIds: string[];
}

/** Every column naming who wrote, made or decided something. `mergeGuest.test.ts`
    fails when a new column that can hold a server user id is not accounted for. */
export const AUTHOR_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["messages", "sender_server_id"],
  ["threads", "created_by"],
  ["conversations", "created_by_server_user_id"],
  ["files", "uploaded_by_server_user_id"],
  ["emojis", "uploaded_by_server_user_id"],
  ["emoji_jobs", "uploaded_by_server_user_id"],
  ["webhooks", "created_by_server_user_id"],
  ["invites", "created_by_server_user_id"],
  ["reports", "reporter_server_user_id"],
  ["reports", "message_sender_server_id"],
  ["reports", "resolved_by_server_user_id"],
  ["user_reports", "reported_server_user_id"],
  ["user_reports", "reporter_server_user_id"],
  ["user_reports", "resolved_by_server_user_id"],
  ["bans", "banned_by_server_user_id"],
  ["join_requests", "decided_by_server_user_id"],
  ["bots", "decided_by_server_user_id"],
  ["audit_log", "actor_server_user_id"],
  ["audit_log", "target"],
];

interface MemberRow {
  server_user_id: string;
  is_active: number;
  created_at: string;
  last_seen: string;
  is_server_muted: number;
  server_mute_expires_at: string | null;
  is_server_deafened: number;
}

/**
 * Folds a guest's membership into the account's, which keeps its own name, picture
 * and roles. Null when either membership is gone by the time the transaction starts.
 */
export function mergeGuestIntoAccount(
  guestGrytUserId: string,
  accountGrytUserId: string,
): GuestMerge | null {
  const db = getSqliteDb();
  // IMMEDIATE: this reads before it writes, and the image worker writes to the same file.
  db.exec("BEGIN IMMEDIATE");
  try {
    const merged = mergeInTransaction(db, guestGrytUserId, accountGrytUserId);
    db.exec(merged ? "COMMIT" : "ROLLBACK");
    return merged;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function mergeInTransaction(
  db: DatabaseSync,
  guestGrytUserId: string,
  accountGrytUserId: string,
): GuestMerge | null {
  const member = db.prepare(
    `SELECT server_user_id, is_active, created_at, last_seen, is_server_muted,
            server_mute_expires_at, is_server_deafened
       FROM users WHERE gryt_user_id = ?`,
  );
  const guest = member.get(guestGrytUserId) as MemberRow | undefined;
  const account = member.get(accountGrytUserId) as MemberRow | undefined;
  if (!guest || !account || guest.server_user_id === account.server_user_id) return null;

  const from = guest.server_user_id;
  const to = account.server_user_id;
  const now = new Date();

  const conversationIds = (
    db.prepare(`SELECT conversation_id FROM conversation_members WHERE server_user_id = ?`).all(from) as {
      conversation_id: string;
    }[]
  ).map((r) => r.conversation_id);

  // Both keyed on the pair, so where both already hold a row the account's is kept.
  db.prepare(
    `DELETE FROM conversation_members WHERE server_user_id = ?
        AND conversation_id IN (SELECT conversation_id FROM conversation_members WHERE server_user_id = ?)`,
  ).run(from, to);
  db.prepare(`UPDATE conversation_members SET server_user_id = ? WHERE server_user_id = ?`).run(to, from);
  db.prepare(
    `DELETE FROM mentions WHERE server_user_id = ?
        AND message_id IN (SELECT message_id FROM mentions WHERE server_user_id = ?)`,
  ).run(from, to);
  db.prepare(`UPDATE mentions SET server_user_id = ? WHERE server_user_id = ?`).run(to, from);

  for (const [table, column] of AUTHOR_COLUMNS) {
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(to, from);
  }

  mergeReactions(db, from, to);
  mergeBlocks(db, guestGrytUserId, accountGrytUserId);

  const ownerMoved =
    db
      .prepare(`UPDATE server_config SET owner_gryt_user_id = ?, updated_at = ? WHERE owner_gryt_user_id = ?`)
      .run(accountGrytUserId, toIso(now), guestGrytUserId).changes > 0;

  db.prepare(`DELETE FROM roles WHERE server_user_id = ?`).run(from);
  if (ownerMoved) {
    db.prepare(
      `INSERT INTO roles (server_user_id, role, created_at, updated_at) VALUES (?, 'owner', ?, ?)
       ON CONFLICT(server_user_id, role) DO NOTHING`,
    ).run(to, toIso(now), toIso(now));
  }

  // The stricter moderation state wins, or saying yes would be a way to shed a mute.
  const mute = strongerMute(account, guest, now);
  db.prepare(
    `UPDATE users SET is_active = ?, created_at = ?, last_seen = ?, is_server_muted = ?,
            server_mute_expires_at = ?, is_server_deafened = ?
      WHERE server_user_id = ?`,
  ).run(
    account.is_active === 1 || guest.is_active === 1 ? 1 : 0,
    earliest(account.created_at, guest.created_at),
    account.last_seen > guest.last_seen ? account.last_seen : guest.last_seen,
    mute.muted ? 1 : 0,
    mute.expiresAt,
    account.is_server_deafened === 1 || guest.is_server_deafened === 1 ? 1 : 0,
    to,
  );

  db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE gryt_user_id = ? AND revoked = 0`).run(guestGrytUserId);
  db.prepare(`DELETE FROM users WHERE server_user_id = ?`).run(from);

  return { guestServerUserId: from, accountServerUserId: to, ownerMoved, conversationIds };
}

/** Reactions are JSON on the message, so each row is rewritten. One person who
    reacted twice with the same emoji, once as each, counts once. */
function mergeReactions(db: DatabaseSync, from: string, to: string): void {
  const rows = db
    .prepare(`SELECT conversation_id, message_id, reactions FROM messages WHERE reactions LIKE ?`)
    .all(`%${from}%`) as { conversation_id: string; message_id: string; reactions: string }[];
  const update = db.prepare(`UPDATE messages SET reactions = ? WHERE conversation_id = ? AND message_id = ?`);

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.reactions);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    let touched = false;
    const next = (parsed as Reaction[]).map((r) => {
      if (!Array.isArray(r?.users) || !r.users.includes(from)) return r;
      touched = true;
      const users = [...new Set(r.users.map((u) => (u === from ? to : u)))];
      return { ...r, users, amount: users.length };
    });
    if (touched) update.run(JSON.stringify(next), row.conversation_id, row.message_id);
  }
}

/** Both directions, so a block on the guest still holds against the same person.
    A block between the guest and the account would be a block on yourself, and goes. */
function mergeBlocks(db: DatabaseSync, guest: string, account: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO blocks (blocker_gryt_user_id, blocked_gryt_user_id, created_at)
     SELECT ?, blocked_gryt_user_id, created_at FROM blocks
      WHERE blocker_gryt_user_id = ? AND blocked_gryt_user_id <> ?`,
  ).run(account, guest, account);
  db.prepare(
    `INSERT OR IGNORE INTO blocks (blocker_gryt_user_id, blocked_gryt_user_id, created_at)
     SELECT blocker_gryt_user_id, ?, created_at FROM blocks
      WHERE blocked_gryt_user_id = ? AND blocker_gryt_user_id <> ?`,
  ).run(account, guest, account);
  db.prepare(`DELETE FROM blocks WHERE blocker_gryt_user_id = ? OR blocked_gryt_user_id = ?`).run(guest, guest);
}

function strongerMute(
  a: MemberRow,
  b: MemberRow,
  now: Date,
): { muted: boolean; expiresAt: string | null } {
  const live = (m: MemberRow) =>
    m.is_server_muted === 1 && (!m.server_mute_expires_at || new Date(m.server_mute_expires_at) > now);
  const muted = [a, b].filter(live);
  if (muted.length === 0) return { muted: false, expiresAt: null };
  if (muted.some((m) => !m.server_mute_expires_at)) return { muted: true, expiresAt: null };
  const expiries = muted.map((m) => m.server_mute_expires_at as string).sort();
  return { muted: true, expiresAt: expiries[expiries.length - 1] };
}

/** An empty `created_at` is a row from before the column, which the migration backfills. */
function earliest(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
