import { getSqliteDb, toIso } from "./connection";

export interface MentionRecord {
  conversation_id: string;
  message_id: string;
  created_at: string;
  /**
   * The thread the naming happened in, or null for one in the channel itself.
   *
   * Read off the message rather than stored here. The mentions table has one
   * row per person per message and a foreign key to messages, so the thread is
   * already known — a column of its own would be a second copy that a moved
   * message could disagree with.
   */
  thread_id: string | null;
}

/**
 * Record that a message named these people. `INSERT OR IGNORE`, so an edit that
 * re-parses the same message does not double up or reset a mention somebody has
 * already read.
 *
 * The sender is dropped here rather than by the caller: a path that forgot
 * would notify somebody about their own sentence.
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
      /* Joined rather than left-joined: the foreign key means a mention whose
         message is gone has already been deleted with it, so an inner join
         cannot lose a row that should still be counted. */
      `SELECT m.conversation_id, m.message_id, m.created_at, msg.thread_id
         FROM mentions m
         JOIN messages msg
           ON msg.conversation_id = m.conversation_id
          AND msg.message_id = m.message_id
        WHERE m.server_user_id = ? AND m.seen_at IS NULL
        ORDER BY m.created_at ASC LIMIT ?`,
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
 * Three things decide how much, so they arrive named rather than as a run of
 * positional arguments that are easy to pass in the wrong order:
 *
 * | Given | Cleared |
 * |---|---|
 * | nothing | everything on this server |
 * | a conversation | the mentions in its timeline |
 * | a conversation and a thread | that thread's |
 * | a conversation and `includeThreads` | the conversation, threads and all |
 *
 * A conversation on its own clears what was on screen. A thread reply is not
 * in the channel timeline — the client filters replies out and shows the root
 * — so opening the channel is not reading it, and clearing it there would take
 * the count off the topic row before anybody could see which topic it pointed
 * at (GRYT-1014).
 *
 * `includeThreads` is for the other case: somebody saying they are done with a
 * channel rather than glancing at it (GRYT-1030). Nothing infers it — it is
 * always a thing the person asked for.
 *
 * Already-seen rows are left alone either way, so the time recorded stays the
 * first time they saw it.
 */
export async function markMentionsSeen(args: {
  serverUserId: string;
  conversationId?: string;
  threadId?: string;
  /** The conversation and every thread in it, not only its timeline. */
  includeThreads?: boolean;
}): Promise<number> {
  const { serverUserId, conversationId, threadId, includeThreads } = args;
  const db = getSqliteDb();
  const seen_at = toIso(new Date());

  /* Which thread a mention is in lives on the message, not on the row being
     updated, so the thread-scoped statements go through a subquery against
     `messages` on the pair the foreign key is built from. */
  let result;
  if (conversationId && threadId) {
    result = db
      .prepare(
        `UPDATE mentions SET seen_at = ?
          WHERE server_user_id = ? AND conversation_id = ? AND seen_at IS NULL
            AND message_id IN (
              SELECT message_id FROM messages
               WHERE conversation_id = ? AND thread_id = ?
            )`,
      )
      .run(seen_at, serverUserId, conversationId, conversationId, threadId);
  } else if (conversationId && includeThreads) {
    // No subquery: every mention in the conversation, wherever in it it sits.
    result = db
      .prepare(
        `UPDATE mentions SET seen_at = ?
          WHERE server_user_id = ? AND conversation_id = ? AND seen_at IS NULL`,
      )
      .run(seen_at, serverUserId, conversationId);
  } else if (conversationId) {
    result = db
      .prepare(
        `UPDATE mentions SET seen_at = ?
          WHERE server_user_id = ? AND conversation_id = ? AND seen_at IS NULL
            AND message_id IN (
              SELECT message_id FROM messages
               WHERE conversation_id = ? AND thread_id IS NULL
            )`,
      )
      .run(seen_at, serverUserId, conversationId, conversationId);
  } else {
    result = db
      .prepare(`UPDATE mentions SET seen_at = ? WHERE server_user_id = ? AND seen_at IS NULL`)
      .run(seen_at, serverUserId);
  }

  return Number(result.changes ?? 0);
}
