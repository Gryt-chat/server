import { getSqliteDb, toIso } from "./connection";

/**
 * Who somebody does not want to hear from.
 *
 * A personal act rather than a moderator one, which is what makes it a
 * different table from `bans`: it needs no permission, it works against
 * somebody who outranks you, and the row is nobody's business but the
 * blocker's.
 *
 * **Every function here takes gryt ids, not server ids.** Same reasoning as
 * `bans`: a block keyed on `server_user_id` would last until the blocked
 * person rejoined with a fresh local identity, which is one tap. Callers hold
 * `server_user_id` far more often, so `blockedGrytIdsFor` and
 * `blockersOfSender` exist to be called with what a caller has.
 */

export interface BlockedPerson {
  grytUserId: string;
  serverUserId: string | null;
  nickname: string | null;
  createdAt: string;
}

export async function blockUser(
  blockerGrytUserId: string,
  blockedGrytUserId: string,
): Promise<void> {
  const db = getSqliteDb();
  /* OR IGNORE rather than OR REPLACE. Blocking somebody twice is the same
   * state, and replacing would move `created_at` forward for no reason. */
  db.prepare(
    `INSERT OR IGNORE INTO blocks (blocker_gryt_user_id, blocked_gryt_user_id, created_at) VALUES (?, ?, ?)`,
  ).run(blockerGrytUserId, blockedGrytUserId, toIso(new Date()));
}

export async function unblockUser(
  blockerGrytUserId: string,
  blockedGrytUserId: string,
): Promise<void> {
  const db = getSqliteDb();
  db.prepare(
    `DELETE FROM blocks WHERE blocker_gryt_user_id = ? AND blocked_gryt_user_id = ?`,
  ).run(blockerGrytUserId, blockedGrytUserId);
}

/**
 * The people one person has blocked, for their own list.
 *
 * `LEFT JOIN`, because somebody blocked and then banned is gone from `users`
 * and the row here outlives them. A list that dropped those would look as
 * though the block had been undone.
 */
export async function listBlocks(blockerGrytUserId: string): Promise<BlockedPerson[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      `SELECT b.blocked_gryt_user_id, b.created_at, u.server_user_id, u.nickname
         FROM blocks b
         LEFT JOIN users u ON u.gryt_user_id = b.blocked_gryt_user_id
        WHERE b.blocker_gryt_user_id = ?
        ORDER BY b.created_at DESC`,
    )
    .all(blockerGrytUserId) as {
    blocked_gryt_user_id: string;
    created_at: string;
    server_user_id: string | null;
    nickname: string | null;
  }[];

  return rows.map((r) => ({
    grytUserId: r.blocked_gryt_user_id,
    serverUserId: r.server_user_id,
    nickname: r.nickname,
    createdAt: r.created_at,
  }));
}

/**
 * Whether either of two people has blocked the other.
 *
 * Both directions in one query, because every caller wants both: opening a
 * conversation is refused whichever of the two did the blocking, and asking
 * one way round would let the blocked person start the conversation the block
 * exists to prevent.
 */
export async function eitherHasBlocked(
  aGrytUserId: string,
  bGrytUserId: string,
): Promise<boolean> {
  const db = getSqliteDb();
  const row = db
    .prepare(
      `SELECT 1 FROM blocks
        WHERE (blocker_gryt_user_id = ? AND blocked_gryt_user_id = ?)
           OR (blocker_gryt_user_id = ? AND blocked_gryt_user_id = ?)
        LIMIT 1`,
    )
    .get(aGrytUserId, bGrytUserId, bGrytUserId, aGrytUserId);
  return !!row;
}

/**
 * The `server_user_id`s whose owners have blocked this sender.
 *
 * The delivery question, asked the way delivery has it: a sender's server id
 * in, the server ids of everybody who does not want their message out. Both
 * sides are translated through `users` here rather than at every call site.
 *
 * A `Set` rather than an array because the caller filters a recipient list
 * against it once per message.
 */
export async function blockersOfSender(senderServerUserId: string): Promise<Set<string>> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      `SELECT blocker.server_user_id AS server_user_id
         FROM blocks b
         JOIN users sender  ON sender.gryt_user_id  = b.blocked_gryt_user_id
         JOIN users blocker ON blocker.gryt_user_id = b.blocker_gryt_user_id
        WHERE sender.server_user_id = ?`,
    )
    .all(senderServerUserId) as { server_user_id: string }[];

  return new Set(rows.map((r) => r.server_user_id));
}

/**
 * The `server_user_id`s one person has blocked, for filtering history.
 *
 * The other direction from `blockersOfSender`, and the one a fetch needs: it
 * knows who is reading and has to drop the senders they do not want.
 */
export async function blockedServerIdsFor(
  blockerServerUserId: string,
): Promise<Set<string>> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      `SELECT blocked.server_user_id AS server_user_id
         FROM blocks b
         JOIN users blocker ON blocker.gryt_user_id = b.blocker_gryt_user_id
         JOIN users blocked ON blocked.gryt_user_id = b.blocked_gryt_user_id
        WHERE blocker.server_user_id = ?`,
    )
    .all(blockerServerUserId) as { server_user_id: string }[];

  return new Set(rows.map((r) => r.server_user_id));
}
