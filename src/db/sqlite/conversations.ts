import { createHash, randomUUID } from "crypto";

import type { ConversationRecord } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

/**
 * Conversations that are not channels: visible only to the people listed in
 * `conversation_members`.
 *
 * **Nothing here is cross-server, deliberately.** A DM is filed under
 * `server_user_id`, this server's own pseudonym for somebody, so two servers
 * cannot tell they host the same pair of people. The alternative needs either a
 * central store of everybody's private messages or servers that know about each
 * other.
 */

/** The prefix every direct-message conversation id carries. */
const DM_PREFIX = "dm_";

/**
 * How many people may be in one group.
 *
 * A cap because every message fans out to every member and the member list
 * rides in each `dm:list`. Ten is Discord's number and there is no better
 * reason for a different one; what matters is that there is a limit at all,
 * decided here rather than by whoever first tries to add a hundred people.
 */
export const MAX_CONVERSATION_MEMBERS = 10;

/**
 * The id of the direct message between two members, derived from the pair so
 * both sides reach the same one without asking each other. Sorted first.
 *
 * **This id is not a secret and must never be treated as one.** Anybody with
 * both `server_user_id`s can compute it, and member lists carry those. Access
 * is decided by `conversation_members`, never by naming the id — which is
 * exactly the mistake `chat:fetch` used to make for channels.
 */
export function directConversationId(a: string, b: string): string {
  const pair = [a, b].sort();
  // A NUL, written as an escape. It has to be a byte that cannot occur in a
  // server_user_id, or ["ab", "c"] and ["a", "bc"] hash to the same
  // conversation and one pair reads the other's messages.
  //
  // Raw in the source it made git treat this file as binary, so an editor that
  // dropped it would have changed the id of every existing conversation with
  // nothing visible in the diff. The escape cannot go missing unnoticed.
  const digest = createHash("sha256").update(pair.join("\0")).digest("hex");
  return `${DM_PREFIX}${digest.slice(0, 32)}`;
}

/**
 * Whether an id names a conversation rather than a channel. A prefix test, not
 * a lookup: the member list is rebuilt on every voice state change.
 *
 * Safe in the direction that matters — every conversation id carries the
 * prefix, so this can never answer "channel" for one. The reverse costs a
 * channel named `dm_something` its place in the member list.
 */
export function isConversationId(id: string): boolean {
  return id.startsWith(DM_PREFIX);
}

function rowToConversation(r: Record<string, unknown>): ConversationRecord {
  const kind = r.kind === "group" ? "group" : "dm";
  return {
    conversation_id: r.conversation_id as string,
    kind,
    // Never on a one-to-one. The column is nullable and nothing writes it for
    // a `dm`, but reading it back as null unconditionally means a row that
    // somehow has one cannot start showing a name on a pair conversation.
    name: kind === "group" ? ((r.name as string) ?? null) : null,
    icon_file_id: kind === "group" ? ((r.icon_file_id as string) ?? null) : null,
    created_by_server_user_id: (r.created_by_server_user_id as string) ?? null,
    created_at: fromIso(r.created_at as string),
    last_message_at: fromIsoNullable(r.last_message_at as string | null),
  };
}

export async function getConversation(conversationId: string): Promise<ConversationRecord | null> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT * FROM conversations WHERE conversation_id = ?`)
    .get(conversationId) as Record<string, unknown> | undefined;
  return row ? rowToConversation(row) : null;
}

/**
 * Whether this member is party to this conversation.
 *
 * The only question the read and write paths ask. A conversation the table does
 * not know about is not "open to everyone" here — the caller decides what an
 * unknown id means, because for a channel it means something different than it
 * does for a DM.
 */
export async function isConversationMember(conversationId: string, serverUserId: string): Promise<boolean> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND server_user_id = ?`)
    .get(conversationId, serverUserId) as { ok: number } | undefined;
  return !!row;
}

export async function listConversationMemberIds(conversationId: string): Promise<string[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT server_user_id FROM conversation_members WHERE conversation_id = ?`)
    .all(conversationId) as { server_user_id: string }[];
  return rows.map((r) => r.server_user_id);
}

export interface ConversationSummary extends ConversationRecord {
  /** Everybody else in it. One id today; group DMs are why this is a list. */
  other_server_user_ids: string[];
}

/**
 * Every conversation this member is party to and has not hidden, most recent
 * first. `created_at` is the fallback so a DM opened and never used still
 * appears rather than sorting below everything.
 *
 * Hidden rows are filtered here rather than at the handler, so one place
 * decides what a person's list contains.
 */
export async function listConversationsForUser(serverUserId: string): Promise<ConversationSummary[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.conversation_id
       WHERE m.server_user_id = ? AND m.hidden_at IS NULL
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    )
    .all(serverUserId) as Record<string, unknown>[];

  return rows.map((r) => {
    const conversation = rowToConversation(r);
    const others = db
      .prepare(`SELECT server_user_id FROM conversation_members WHERE conversation_id = ? AND server_user_id != ?`)
      .all(conversation.conversation_id, serverUserId) as { server_user_id: string }[];
    return { ...conversation, other_server_user_ids: others.map((o) => o.server_user_id) };
  });
}

/**
 * Open the direct message between two members, or return the one that exists.
 *
 * Idempotent on purpose. Both ends can call this at the same moment and both
 * get the same conversation, because the id is derived from the pair rather
 * than generated — the insert simply loses the race harmlessly.
 */
/**
 * Start a group conversation. **A random id, not a derived one** — a hashed one
 * cannot survive membership changing, since adding somebody would change the id
 * and the conversation would read as a different one with no history.
 *
 * So adding somebody to a one-to-one makes a new group and leaves the pair
 * conversation alone: its history should not become readable by a third because
 * somebody tapped add.
 */
export async function createGroupConversation(
  createdBy: string,
  memberIds: string[],
): Promise<ConversationRecord> {
  const members = [...new Set([createdBy, ...memberIds])];
  if (members.length < 3) {
    throw new Error("createGroupConversation: a group needs at least three people");
  }
  if (members.length > MAX_CONVERSATION_MEMBERS) {
    throw new Error(`createGroupConversation: at most ${MAX_CONVERSATION_MEMBERS} people`);
  }

  const db = getSqliteDb();
  const conversationId = `${DM_PREFIX}g${randomUUID().replace(/-/g, "")}`;
  const now = toIso(new Date());

  db.prepare(
    `INSERT INTO conversations (conversation_id, kind, created_by_server_user_id, created_at)
     VALUES (?, 'group', ?, ?)`,
  ).run(conversationId, createdBy, now);

  const addMember = db.prepare(
    `INSERT INTO conversation_members (conversation_id, server_user_id, created_at)
     VALUES (?, ?, ?) ON CONFLICT(conversation_id, server_user_id) DO NOTHING`,
  );
  for (const id of members) addMember.run(conversationId, id, now);

  const created = await getConversation(conversationId);
  if (!created) throw new Error("createGroupConversation: conversation vanished after insert");
  return created;
}

/** Put somebody into a group. Returns false when they were already in it. */
export async function addConversationMember(
  conversationId: string,
  serverUserId: string,
): Promise<boolean> {
  const db = getSqliteDb();
  const existing = await listConversationMemberIds(conversationId);
  if (existing.includes(serverUserId)) return false;
  if (existing.length >= MAX_CONVERSATION_MEMBERS) {
    throw new Error(`addConversationMember: at most ${MAX_CONVERSATION_MEMBERS} people`);
  }
  db.prepare(
    `INSERT INTO conversation_members (conversation_id, server_user_id, created_at)
     VALUES (?, ?, ?) ON CONFLICT(conversation_id, server_user_id) DO NOTHING`,
  ).run(conversationId, serverUserId, toIso(new Date()));
  return true;
}

/**
 * Take yourself out of a group for good. Not hiding: the membership row goes,
 * so nothing arrives afterwards and the history stops being readable. Only ever
 * the caller's own row — a conversation has no moderators.
 */
export async function leaveConversation(
  conversationId: string,
  serverUserId: string,
): Promise<boolean> {
  const db = getSqliteDb();
  const result = db
    .prepare(`DELETE FROM conversation_members WHERE conversation_id = ? AND server_user_id = ?`)
    .run(conversationId, serverUserId);
  return result.changes > 0;
}

/** Give a group an uploaded picture, or clear it back to the drawn one. */
export async function setConversationIcon(
  conversationId: string,
  fileId: string | null,
): Promise<void> {
  const db = getSqliteDb();
  db.prepare(
    `UPDATE conversations SET icon_file_id = ? WHERE conversation_id = ? AND kind = 'group'`,
  ).run(fileId, conversationId);
}

/** Name a group, or clear the name so it goes back to reading off its members. */
export async function setConversationName(
  conversationId: string,
  name: string | null,
): Promise<void> {
  const db = getSqliteDb();
  const trimmed = name === null ? null : name.trim().slice(0, 80) || null;
  db.prepare(`UPDATE conversations SET name = ? WHERE conversation_id = ? AND kind = 'group'`).run(
    trimmed,
    conversationId,
  );
}

export async function openDirectConversation(
  a: string,
  b: string,
): Promise<ConversationRecord> {
  if (a === b) throw new Error("openDirectConversation: cannot open a conversation with yourself");

  const db = getSqliteDb();
  const conversationId = directConversationId(a, b);
  const existing = await getConversation(conversationId);
  if (existing) return existing;

  const now = toIso(new Date());
  db.prepare(
    `INSERT INTO conversations (conversation_id, kind, created_by_server_user_id, created_at)
     VALUES (?, 'dm', ?, ?)
     ON CONFLICT(conversation_id) DO NOTHING`,
  ).run(conversationId, a, now);

  const addMember = db.prepare(
    `INSERT INTO conversation_members (conversation_id, server_user_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id, server_user_id) DO NOTHING`,
  );
  addMember.run(conversationId, a, now);
  addMember.run(conversationId, b, now);

  const created = await getConversation(conversationId);
  if (!created) throw new Error("openDirectConversation: conversation vanished after insert");
  return created;
}

/**
 * Take a conversation out of one person's list, or put it back.
 *
 * Only ever touches the caller's own row. Returns whether anything changed, so
 * a handler can decline to tell everybody about a no-op.
 */
/**
 * Take the conversation between two people out of one of their sidebars, when
 * somebody blocks. The blocked person's list is untouched and nothing is
 * deleted.
 *
 * **Only the direct conversation.** Touching a group both are in would be a
 * block with a blast radius.
 */
export async function hideConversationsBetween(
  blockerServerUserId: string,
  blockedServerUserId: string,
): Promise<void> {
  const db = getSqliteDb();
  db.prepare(
    `UPDATE conversation_members SET hidden_at = ?
      WHERE conversation_id = ? AND server_user_id = ? AND hidden_at IS NULL`,
  ).run(
    toIso(new Date()),
    directConversationId(blockerServerUserId, blockedServerUserId),
    blockerServerUserId,
  );
}

export async function setConversationHidden(
  conversationId: string,
  serverUserId: string,
  hidden: boolean,
): Promise<boolean> {
  const db = getSqliteDb();
  const result = db
    .prepare(
      `UPDATE conversation_members SET hidden_at = ?
       WHERE conversation_id = ? AND server_user_id = ? AND (hidden_at IS NULL) = ?`,
    )
    .run(hidden ? toIso(new Date()) : null, conversationId, serverUserId, hidden ? 1 : 0);
  return result.changes > 0;
}

/**
 * Un-hide a conversation for everybody in it, when a message lands. Hiding is
 * "not in my sidebar", and without this a hidden conversation would silently
 * swallow everything sent afterwards. Blocking is the feature that means the
 * other thing — see `hideConversationsBetween`.
 *
 * Returns the members it un-hid, so a caller can tell whose list changed.
 */
export async function clearConversationHidden(conversationId: string): Promise<string[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      `SELECT server_user_id FROM conversation_members
       WHERE conversation_id = ? AND hidden_at IS NOT NULL`,
    )
    .all(conversationId) as { server_user_id: string }[];
  if (rows.length === 0) return [];

  db.prepare(`UPDATE conversation_members SET hidden_at = NULL WHERE conversation_id = ?`).run(
    conversationId,
  );
  return rows.map((r) => r.server_user_id);
}

export async function touchConversation(conversationId: string, at: Date = new Date()): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE conversations SET last_message_at = ? WHERE conversation_id = ?`).run(toIso(at), conversationId);
}

/**
 * Drop conversations nobody is still a member of, and their messages. The
 * retention rule, deliberately not a timer: once the last participant leaves
 * nobody can ever open it, so keeping it means holding private messages on
 * behalf of people who have both gone.
 *
 * Leaving is `is_active = 0` rather than a delete, so this joins against that
 * rather than looking for missing users.
 */
export async function purgeOrphanedConversations(): Promise<string[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      `SELECT c.conversation_id FROM conversations c
       WHERE NOT EXISTS (
         SELECT 1 FROM conversation_members m
         JOIN users u ON u.server_user_id = m.server_user_id
         WHERE m.conversation_id = c.conversation_id AND u.is_active = 1
       )`,
    )
    .all() as { conversation_id: string }[];

  const ids = rows.map((r) => r.conversation_id);
  if (ids.length === 0) return [];

  const deleteMessages = db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);
  const deleteMembers = db.prepare(`DELETE FROM conversation_members WHERE conversation_id = ?`);
  const deleteConversation = db.prepare(`DELETE FROM conversations WHERE conversation_id = ?`);
  for (const id of ids) {
    deleteMessages.run(id);
    deleteMembers.run(id);
    deleteConversation.run(id);
  }
  return ids;
}
