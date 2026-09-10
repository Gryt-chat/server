import { createHash, randomUUID } from "crypto";

import type { ConversationRecord } from "../interfaces";
import { fromIso, fromIsoNullable, getSqliteDb, toIso } from "./connection";

/**
 * Nothing here is cross-server: a DM is filed under `server_user_id`, this
 * server's own pseudonym, so two servers cannot tell they host the same pair.
 */

/** The prefix every direct-message conversation id carries. */
const DM_PREFIX = "dm_";

/** Every message fans out to every member and the member list rides in each
    `dm:list`. Ten is Discord's number; what matters is that there is one. */
export const MAX_CONVERSATION_MEMBERS = 10;

/** Derived from the sorted pair, so both sides reach the same one. Not a
    secret: access is `conversation_members`, never naming the id. */
export function directConversationId(a: string, b: string): string {
  const pair = [a, b].sort();
  // A byte that cannot occur in a server_user_id, or ["ab","c"] and ["a","bc"]
  // hash alike. An escape, because raw it made git treat this file as binary.
  const digest = createHash("sha256").update(pair.join("\0")).digest("hex");
  return `${DM_PREFIX}${digest.slice(0, 32)}`;
}

/** A prefix test, not a lookup, since the member list is rebuilt on every voice
    change. Safe one way: it can never answer "channel" for a conversation. */
export function isConversationId(id: string): boolean {
  return id.startsWith(DM_PREFIX);
}

function rowToConversation(r: Record<string, unknown>): ConversationRecord {
  const kind = r.kind === "group" ? "group" : "dm";
  return {
    conversation_id: r.conversation_id as string,
    kind,
    // Read back as null unconditionally, so a `dm` row that somehow has a name
    // cannot start showing one.
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

/** An unknown id is not "open to everyone" here: the caller decides what it
    means, because a channel and a DM differ. */
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

/* Hidden rows and empty ones are filtered here, so one place decides what a list
   holds. `created_at` is the fallback sort, for a conversation opened and unused. */
export async function listConversationsForUser(serverUserId: string): Promise<ConversationSummary[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(
      /* An empty one-to-one belongs only to whoever opened it, or clicking through
         a member list fills everybody else's. Groups are exempt. */
      `SELECT c.* FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.conversation_id
       WHERE m.server_user_id = ? AND m.hidden_at IS NULL
         AND (c.kind != 'dm'
              OR c.last_message_at IS NOT NULL
              OR c.created_by_server_user_id = ?)
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    )
    .all(serverUserId, serverUserId) as Record<string, unknown>[];

  return rows.map((r) => {
    const conversation = rowToConversation(r);
    const others = db
      .prepare(`SELECT server_user_id FROM conversation_members WHERE conversation_id = ? AND server_user_id != ?`)
      .all(conversation.conversation_id, serverUserId) as { server_user_id: string }[];
    return { ...conversation, other_server_user_ids: others.map((o) => o.server_user_id) };
  });
}

/**
 * A random id, not a derived one, which could not survive membership changing.
 * So adding somebody to a pair makes a new group and leaves the pair alone.
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

/** Not hiding: the membership row goes, so the history stops being readable.
    Only the caller's own row; a conversation has no moderators. */
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
 * The blocker's sidebar only, with nothing deleted. Only the direct
 * conversation: touching a group both are in is a block with a blast radius.
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

/** Hiding is "not in my sidebar", so without this a hidden conversation swallows
    everything sent afterwards. Returns whose list changed. */
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

/** Once the last participant leaves nobody can open it, so keeping it holds
    private messages for people who have gone. Leaving is `is_active = 0`. */
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
