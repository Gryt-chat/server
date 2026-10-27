import { getSqliteDb } from "./connection";

/**
 * Where somebody has read up to in a conversation, so unread survives a restart and
 * follows them to another device. Channels only: a DM's would be a read receipt.
 */
export interface ReadMarker {
  conversation_id: string;
  /** The message's own created_at, not when anybody looked. */
  read_through_at: string;
  read_through_message_id: string;
}

/**
 * Moves the marker to a message, and only forwards. Two devices reading the same
 * conversation race, and the one that finishes last is not the one that read furthest.
 */
export async function setReadMarker(args: {
  serverUserId: string;
  conversationId: string;
  messageId: string;
}): Promise<boolean> {
  const db = getSqliteDb();

  /* The message supplies the position. An id this server does not hold -- deleted, or
     never here -- moves nothing, rather than parking the marker somewhere unorderable. */
  const at = db
    .prepare(`SELECT created_at FROM messages WHERE conversation_id = ? AND message_id = ?`)
    .get(args.conversationId, args.messageId) as { created_at: string } | undefined;
  if (!at) return false;

  /* ON CONFLICT with a WHERE, so a marker never goes backwards. created_at is an ISO
     string to the millisecond, so message_id breaks the ties it cannot. */
  const result = db
    .prepare(
      `INSERT INTO read_markers (server_user_id, conversation_id, read_through_at, read_through_message_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server_user_id, conversation_id) DO UPDATE SET
         read_through_at = excluded.read_through_at,
         read_through_message_id = excluded.read_through_message_id
        WHERE excluded.read_through_at > read_markers.read_through_at
           OR (excluded.read_through_at = read_markers.read_through_at
               AND excluded.read_through_message_id > read_markers.read_through_message_id)`,
    )
    .run(args.serverUserId, args.conversationId, at.created_at, args.messageId);

  return Number(result.changes ?? 0) > 0;
}

/** Every marker this person has, for a client that wants to count for itself. */
export async function listReadMarkers(serverUserId: string): Promise<ReadMarker[]> {
  const db = getSqliteDb();
  return db
    .prepare(
      `SELECT conversation_id, read_through_at, read_through_message_id
         FROM read_markers WHERE server_user_id = ?`,
    )
    .all(serverUserId) as unknown as ReadMarker[];
}

/**
 * How many messages have arrived since each marker. One query rather than one per
 * conversation, joined on the index messages already has for its timeline.
 */
export async function countUnreadByConversation(
  serverUserId: string,
): Promise<Record<string, number>> {
  const db = getSqliteDb();

  /* A conversation with no marker is left out, and the client reads absent as caught
     up: joining a server should not light up every channel in it. */
  const rows = db
    .prepare(
      `SELECT m.conversation_id AS conversation_id, COUNT(*) AS n
         FROM read_markers r
         JOIN messages m
           ON m.conversation_id = r.conversation_id
          AND (m.created_at > r.read_through_at
               OR (m.created_at = r.read_through_at
                   AND m.message_id > r.read_through_message_id))
        WHERE r.server_user_id = ?
          -- Replies belong to their thread's count, which the client keeps apart.
          AND m.thread_id IS NULL
          -- Your own messages are not news to you.
          AND m.sender_server_id != ?
        GROUP BY m.conversation_id`,
    )
    .all(serverUserId, serverUserId) as Array<{ conversation_id: string; n: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.conversation_id] = row.n;
  return counts;
}

/** Leaving a server should not leave its markers behind. */
export async function deleteReadMarkers(serverUserId: string, conversationId?: string): Promise<number> {
  const db = getSqliteDb();
  const result = conversationId
    ? db
        .prepare(`DELETE FROM read_markers WHERE server_user_id = ? AND conversation_id = ?`)
        .run(serverUserId, conversationId)
    : db.prepare(`DELETE FROM read_markers WHERE server_user_id = ?`).run(serverUserId);
  return Number(result.changes ?? 0);
}
