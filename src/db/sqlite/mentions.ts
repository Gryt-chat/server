import { getSqliteDb, toIso } from "./connection";

export interface MentionRecord {
  conversation_id: string;
  message_id: string;
  created_at: string;
  /** Read off the message rather than stored: the foreign key means the thread
      is already known, and a column here is a second copy that can disagree. */
  thread_id: string | null;
}

/** `INSERT OR IGNORE`, so a re-parse does not double up or reset a mention
    already read. The sender is dropped here, or a path forgetting notifies them. */
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

/** Oldest first: a list of things waiting reads in the order they arrived. */
export async function listUnseenMentions(
  serverUserId: string,
  limit = 100,
): Promise<MentionRecord[]> {
  const db = getSqliteDb();
  return db
    .prepare(
      /* Joined, not left-joined: the foreign key means a mention whose message is
         gone went with it, so this cannot lose a row worth counting. */
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
 * Nothing clears the server, a conversation its timeline, a thread that thread,
 * `includeThreads` both. A reply is not on screen when a channel opens.
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

  /* The thread lives on the message, not the row being updated, so these go
     through a subquery on the pair the foreign key is built from. */
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
