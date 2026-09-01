import { createHash, randomUUID } from "crypto";

import type { ConversationRecord } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

/**
 * Conversations that are not channels.
 *
 * `messages` has always been keyed on `conversation_id` rather than a channel
 * id, and until now every value in that column happened to be a channel. This
 * table is the other kind: a conversation that exists on its own and is visible
 * only to the people listed against it in `conversation_members`.
 *
 * Nothing here is cross-server, and that is deliberate rather than unfinished.
 * A direct message is filed under `server_user_id`, which is this server's own
 * pseudonym for somebody — see `socket/utils/memberIdentity.ts` for why the
 * account id it is derived from is never handed out. Two servers therefore
 * cannot tell they are hosting the same pair of people, and a DM opened on one
 * has no relationship to a DM opened on the other. That is the whole design:
 * the alternative needs either a central store of everybody's private messages
 * or servers that know about each other, and Gryt wants neither.
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
 * The id of the direct message between two members, derived from the pair.
 *
 * Derived rather than random so that both sides arrive at the same id without
 * asking each other, and so opening the same DM twice — from two devices, or
 * from both ends at once — cannot produce two conversations holding half the
 * history each. Sorted first, because "Alice opened it" and "Bob opened it"
 * have to give the same answer.
 *
 * **This id is not a secret and must never be treated as one.** Anybody who
 * knows both `server_user_id`s can compute it, and member lists carry those.
 * Access is decided by `conversation_members`, never by whether the caller
 * could name the id — which is exactly the mistake `chat:fetch` used to make
 * for channels.
 */
export function directConversationId(a: string, b: string): string {
  const pair = [a, b].sort();
  // The separator is a NUL, written as an escape. It has to be a byte that
  // cannot occur in a server_user_id, or ["ab", "c"] and ["a", "bc"] hash to
  // the same conversation — two different pairs sharing one id, and one
  // pair reading the other's messages.
  //
  // It was a raw NUL in the source until 2026-08-29, which made grep and
  // git treat this file as binary and made the character invisible in every
  // diff and review. Any editor or formatter that dropped it would have
  // changed the id of every existing one-to-one conversation — each one
  // silently becoming a new, empty conversation — with nothing in the diff
  // to see. The escape is the same byte and cannot go missing unnoticed.
  const digest = createHash("sha256").update(pair.join("\0")).digest("hex");
  return `${DM_PREFIX}${digest.slice(0, 32)}`;
}

/**
 * Whether an id names a conversation rather than a channel.
 *
 * A prefix test rather than a lookup, because the callers are on the hot path —
 * the member list is rebuilt and rehashed on every voice state change, and a
 * database read per member per broadcast is not affordable there.
 *
 * Safe in the direction that matters. Every conversation id is written by
 * `directConversationId` or `createGroupConversation`, and both carry the
 * prefix, so this can never answer "channel" for a conversation. The reverse is
 * possible — an admin may name a channel `dm_something` — and costs that
 * channel's id being left out of the member list. Cosmetic, against a leak.
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
 * Every conversation this member is party to and has not hidden, most recently
 * used first.
 *
 * Ordered on `last_message_at` with a fallback to `created_at` so a DM that was
 * opened and never used still appears, rather than sorting below everything as
 * an empty date would put it.
 *
 * Hidden rows are filtered here rather than at the handler, so there is one
 * place that decides what a person's list contains. `hidden_at` is on the
 * membership row, so this is the caller's own answer and not the other
 * party's — see the migration in `connection.ts`.
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
 * Start a group conversation with the people given.
 *
 * A random id, not a derived one. `directConversationId` hashes the pair,
 * which is what makes a one-to-one idempotent from either end — and that
 * property cannot survive membership changing: adding somebody would change
 * the id, and the conversation would read as a different one with no history.
 * So a group is assigned an id once and keeps it.
 *
 * Adding somebody to a one-to-one therefore does not convert it. The caller
 * makes a new group instead, and the pair conversation stays exactly as it
 * was — see `dm:group:create`. That is a privacy decision as much as a
 * technical one: the history of a conversation between two people should not
 * become readable by a third because somebody tapped "add".
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
 * Take yourself out of a group for good.
 *
 * Not the same as hiding it. Hiding is your own sidebar and a message brings
 * it back; leaving removes the membership row, so nothing arrives afterwards
 * and the history stops being readable to you. Only ever the caller's own row
 * — nobody removes anybody else, which keeps a moderation model out of a
 * conversation that has no moderators.
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
 * Take the conversation between two people out of one of their sidebars.
 *
 * Called when somebody blocks: the blocker stops seeing it and the blocked
 * person's own list is untouched, which is the same act the blocker could have
 * performed by hand. Nothing is deleted — unblocking and saying something puts
 * it back with its history intact.
 *
 * Only the direct conversation. A group both of them are in is not between
 * them, and removing somebody from a group because one member blocked another
 * would be a block with a blast radius.
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
 * Un-hide a conversation for everybody in it.
 *
 * Called when a message lands. Hiding is "not in my sidebar", not "never speak
 * to me again" — without this a hidden conversation would swallow every
 * message somebody sent afterwards, silently, and the only sign would be the
 * unread count on a row that is not there.
 *
 * Blocking is the feature that does mean the other thing, and it is not this
 * one; it is on the roadmap as its own item and needs its own decisions.
 *
 * Returns the members it un-hid, so a caller can tell whose list just changed.
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
 * Drop conversations nobody is still a member of, and their messages.
 *
 * The retention rule, and it is deliberately not a timer. A conversation lives
 * as long as at least one participant is still a member of this server; when
 * the last of them leaves there is nobody who can ever open it again, so
 * keeping it would only mean the server holding private messages on behalf of
 * people who have both gone.
 *
 * Leaving is `is_active = 0` rather than a delete — the row stays so that
 * rejoining keeps roles and history — so this joins against that rather than
 * looking for missing users.
 *
 * Returns the ids it removed, for the caller to log.
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
