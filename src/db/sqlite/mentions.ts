import { getSqliteDb, toIso } from "./connection";

export interface MentionRecord {
  conversation_id: string;
  message_id: string;
  created_at: string;
}

/**
 * Record that a message named these people.
 *
 * `INSERT OR IGNORE` because the primary key is the pair, and an edit that
 * re-parses the same message must not double up or reset a mention somebody
 * has already read. First mention wins, which is also the honest reading: they
 * were told once.
 *
 * The sender is dropped here rather than by the caller. Every path that stores
 * a message has to make the same exclusion, and one that forgets would send
 * somebody a notification for their own sentence.
 */
export async function recordMentions(args: {
  conversationId: string;
  messageId: string;
  senderServerUserId: string;
  serverUserIds: string[];
}): Promise<string[]> {
  const targets = args.serverUserIds.filter((id) => id && id !== args.senderServerUserId);
  if (targets.length === 0) return [];

  const db = getSqliteDb();
  const created_at = toIso(new Date());
  const insert = db.prepare(
    `INSERT OR IGNORE INTO mentions (conversation_id, message_id, server_user_id, created_at) VALUES (?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    for (const id of targets) {
      insert.run(args.conversationId, args.messageId, id, created_at);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return targets;
}

/**
 * What somebody has been named in and not yet read.
 *
 * Ordered oldest first: a list of things waiting for you reads in the order
 * they arrived, and the oldest unanswered question is the one most worth
 * seeing.
 */
export async function listUnseenMentions(
  serverUserId: string,
  limit = 100,
): Promise<MentionRecord[]> {
  const db = getSqliteDb();
  return db
    .prepare(
      `SELECT conversation_id, message_id, created_at FROM mentions
       WHERE server_user_id = ? AND seen_at IS NULL
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(serverUserId, Math.min(Math.max(limit, 1), 500)) as unknown as MentionRecord[];
}

/** How many are waiting, per conversation, for a badge. */
export async function countUnseenMentions(
  serverUserId: string,
): Promise<Record<string, number>> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      `SELECT conversation_id, COUNT(*) AS n FROM mentions
       WHERE server_user_id = ? AND seen_at IS NULL GROUP BY conversation_id`,
    )
    .all(serverUserId) as Array<{ conversation_id: string; n: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.conversation_id] = row.n;
  return counts;
}

/**
 * Mark what they have read.
 *
 * By conversation rather than by message, because that is how somebody reads:
 * they open a channel and catch up. Passing no conversation clears everything,
 * which is what a "mark all read" is.
 *
 * Already-seen rows are left alone rather than re-stamped, so the time recorded
 * stays the first time they saw it.
 */
export async function markMentionsSeen(
  serverUserId: string,
  conversationId?: string,
): Promise<number> {
  const db = getSqliteDb();
  const seen_at = toIso(new Date());

  const result = conversationId
    ? db
        .prepare(
          `UPDATE mentions SET seen_at = ? WHERE server_user_id = ? AND conversation_id = ? AND seen_at IS NULL`,
        )
        .run(seen_at, serverUserId, conversationId)
    : db
        .prepare(`UPDATE mentions SET seen_at = ? WHERE server_user_id = ? AND seen_at IS NULL`)
        .run(seen_at, serverUserId);

  return Number(result.changes ?? 0);
}
