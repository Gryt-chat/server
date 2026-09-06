import { randomUUID } from "crypto";

import type { ThreadRecord, ThreadStatus } from "../interfaces";
import { fromIso, getSqliteDb, toIso } from "./connection";

/*
 * A thread is a discussion that hangs off one message. The root message stays
 * in the channel's normal timeline; the replies do not — they carry a
 * `thread_id` and are filtered out of `listMessages` (see messages.ts), so they
 * never pollute the main flow. `reply_count` / `last_message_at` are
 * denormalised counters kept up to date on every reply and delete, so the
 * "N replies" summary and the activity sort never have to scan the messages.
 */

function rowToThread(r: Record<string, unknown>): ThreadRecord {
  return {
    thread_id: r.thread_id as string,
    conversation_id: r.conversation_id as string,
    root_message_id: r.root_message_id as string,
    title: (r.title as string) ?? null,
    created_by: r.created_by as string,
    status: ((r.status as string) ?? "open") as ThreadStatus,
    reply_count: Number(r.reply_count ?? 0),
    locked: Number(r.locked ?? 0) === 1,
    created_at: fromIso(r.created_at as string),
    last_message_at: fromIso(r.last_message_at as string),
  };
}

export async function createThread(record: {
  conversation_id: string;
  root_message_id: string;
  created_by: string;
  title?: string | null;
  thread_id?: string;
  created_at?: Date;
}): Promise<ThreadRecord> {
  const db = getSqliteDb();
  const thread_id = record.thread_id ?? randomUUID();
  const created_at = record.created_at ?? new Date();
  db.prepare(
    `INSERT INTO threads (thread_id, conversation_id, root_message_id, title, created_by, status, reply_count, locked, created_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, 'open', 0, 0, ?, ?)`,
  ).run(
    thread_id,
    record.conversation_id,
    record.root_message_id,
    record.title ?? null,
    record.created_by,
    toIso(created_at),
    toIso(created_at),
  );
  return {
    thread_id,
    conversation_id: record.conversation_id,
    root_message_id: record.root_message_id,
    title: record.title ?? null,
    created_by: record.created_by,
    status: "open",
    reply_count: 0,
    locked: false,
    created_at,
    last_message_at: created_at,
  };
}

export async function getThread(threadId: string): Promise<ThreadRecord | null> {
  const db = getSqliteDb();
  const r = db.prepare(`SELECT * FROM threads WHERE thread_id = ?`).get(threadId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToThread(r) : null;
}

/** At most one thread hangs off a given message — the root_message_id is unique. */
export async function getThreadByRoot(rootMessageId: string): Promise<ThreadRecord | null> {
  const db = getSqliteDb();
  const r = db.prepare(`SELECT * FROM threads WHERE root_message_id = ?`).get(rootMessageId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToThread(r) : null;
}

/** Most-recently-active first, which is how a forum index wants them (GRYT-981, Stage 2). */
export async function listThreadsByConversation(conversationId: string): Promise<ThreadRecord[]> {
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM threads WHERE conversation_id = ? ORDER BY last_message_at DESC`)
    .all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToThread);
}

/** Distinct people in a thread: the root author plus everyone who replied. */
export async function countThreadParticipants(threadId: string, rootMessageId: string): Promise<number> {
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT COUNT(DISTINCT sender_server_id) AS c FROM messages WHERE thread_id = ? OR message_id = ?`)
    .get(threadId, rootMessageId) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export async function bumpThreadOnReply(threadId: string, at: Date): Promise<ThreadRecord | null> {
  const db = getSqliteDb();
  const res = db
    .prepare(`UPDATE threads SET reply_count = reply_count + 1, last_message_at = ? WHERE thread_id = ?`)
    .run(toIso(at), threadId);
  if (res.changes === 0) return null;
  return getThread(threadId);
}

export async function decrementThreadReply(threadId: string): Promise<ThreadRecord | null> {
  const db = getSqliteDb();
  // MAX(0, ...) so a double-delete or a drifted counter can never go negative.
  db.prepare(`UPDATE threads SET reply_count = MAX(0, reply_count - 1) WHERE thread_id = ?`).run(threadId);
  return getThread(threadId);
}

/**
 * Removes a thread and every reply in it, returning what it pointed at so the
 * caller can tell connected clients. The root message itself is a normal
 * channel message and is left alone — deleting it is the caller's separate
 * `deleteMessage` call.
 */
/** Set a thread's status: open, solved (answered, still repliable) or closed (locked). */
export async function setThreadStatus(threadId: string, status: ThreadStatus): Promise<ThreadRecord | null> {
  const db = getSqliteDb();
  const res = db.prepare(`UPDATE threads SET status = ? WHERE thread_id = ?`).run(status, threadId);
  if (res.changes === 0) return null;
  return getThread(threadId);
}

export async function deleteThread(
  threadId: string,
): Promise<{ conversation_id: string; root_message_id: string } | null> {
  const db = getSqliteDb();
  const t = await getThread(threadId);
  if (!t) return null;
  db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(threadId);
  db.prepare(`DELETE FROM threads WHERE thread_id = ?`).run(threadId);
  return { conversation_id: t.conversation_id, root_message_id: t.root_message_id };
}
