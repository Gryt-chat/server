/**
 * The first page of each conversation, kept in memory (GRYT-936).
 *
 * Lived inside `chat.ts` as a bare `Map` that six places reached into
 * directly, each writing its own version of "replace this message" or "take
 * this one out". That was fine while `chat.ts` was the only thing that could
 * change a message. It stopped being fine the moment something outside it
 * could — a plugin deleting a post — because a second caller either imports a
 * private map or forgets the cache and leaves a deleted message on everybody's
 * screen until the entry ages out.
 *
 * So it is a module with four verbs instead. The point is not the encapsulation;
 * it is that "delete a message" has one implementation of what happens to the
 * cache, in one place, whoever asked for it.
 *
 * **It is a cache, not state.** Every entry is reconstructable from the
 * database and nothing here is authoritative. A miss costs one query. That is
 * why every write is best-effort and none of them can fail an operation.
 */

import { listMessages } from "../../db";
import type { MessageRecord } from "../../db/interfaces";

const TTL_MS = parseInt(process.env.MESSAGE_CACHE_TTL_MS || "30000");

/**
 * How many messages one conversation keeps.
 *
 * The cache exists to answer the first page fast. Beyond that it is memory held
 * for a scroll that will hit the database anyway.
 */
const MAX_PER_CONVERSATION = 100;

const cache = new Map<string, { items: MessageRecord[]; fetchedAt: number }>();

/*
 * Entries are dropped at twice the TTL rather than at the TTL. Past the TTL a
 * read refreshes rather than trusting the entry, so keeping it a little longer
 * costs nothing and saves re-reading a busy channel that is queried on either
 * side of the boundary.
 */
export function sweepMessageCache(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > TTL_MS * 2) cache.delete(key);
  }
}

/**
 * The first page, from memory when it is fresh enough and the database when not.
 *
 * `now` is injectable for the same reason `sweepMessageCache` takes one: the
 * only interesting thing about a cache is what it does at the boundary, and a
 * test that cannot move time can only ever assert the fresh half.
 */
export async function getMessagesCached(
  conversationId: string,
  limit = 50,
  now = Date.now(),
): Promise<MessageRecord[]> {
  const cached = cache.get(conversationId);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.items.slice(-limit);

  const items = await listMessages(conversationId, limit);
  cache.set(conversationId, { items, fetchedAt: now });
  return items;
}

/**
 * A new message on the end.
 *
 * Only called when there is already an entry to append to *or* there is not —
 * both are fine. What it must not do is create an entry that looks like a full
 * first page when it holds one message, which is why `fetchedAt` is set to now
 * either way: the next read past the TTL refills from the database regardless.
 */
export function appendCachedMessage(conversationId: string, message: MessageRecord): void {
  const existing = cache.get(conversationId);
  const appended = existing?.items ? [...existing.items, message] : [message];
  const items =
    appended.length > MAX_PER_CONVERSATION ? appended.slice(-MAX_PER_CONVERSATION) : appended;
  cache.set(conversationId, { items, fetchedAt: Date.now() });
}

/**
 * An edit, or a reaction, or anything else that changes a message in place.
 *
 * Does nothing when the conversation is not cached. Creating an entry from one
 * message would claim a first page that is one message long.
 */
export function replaceCachedMessage(conversationId: string, message: MessageRecord): void {
  const existing = cache.get(conversationId);
  if (!existing?.items) return;
  cache.set(conversationId, {
    items: existing.items.map((m) => (m.message_id === message.message_id ? message : m)),
    // Deliberately not refreshed. An edit does not make the page any less stale
    // than it was, and moving it would keep a busy conversation's entry alive
    // past the point where it should have been re-read.
    fetchedAt: existing.fetchedAt,
  });
}

/**
 * A message that is gone.
 *
 * The one everything else here exists for. A delete that updates the database
 * and not this leaves the message on the next person's first page until the
 * entry ages out, which reads as a delete that did not work.
 */
export function dropCachedMessage(conversationId: string, messageId: string): void {
  const existing = cache.get(conversationId);
  if (!existing?.items) return;
  cache.set(conversationId, {
    items: existing.items.filter((m) => m.message_id !== messageId),
    fetchedAt: existing.fetchedAt,
  });
}

/** For tests, which must not inherit a previous case's conversations. */
export function resetMessageCache(): void {
  cache.clear();
}
