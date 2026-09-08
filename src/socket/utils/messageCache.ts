/**
 * The first page of each conversation, in memory. A cache, not state: every
 * entry is reconstructable, so every write here is best-effort.
 */

import { listMessages } from "../../db";
import type { MessageRecord } from "../../db/interfaces";

const TTL_MS = parseInt(process.env.MESSAGE_CACHE_TTL_MS || "30000");

/** Beyond the first page this is memory held for a scroll that will hit the
    database anyway. */
const MAX_PER_CONVERSATION = 100;

const cache = new Map<string, { items: MessageRecord[]; fetchedAt: number }>();

/* Dropped at twice the TTL: past the TTL a read refreshes anyway, so holding it
   longer saves re-reading a channel queried either side of the boundary. */
export function sweepMessageCache(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > TTL_MS * 2) cache.delete(key);
  }
}

/** `now` is injectable because a test that cannot move time can only assert the
    fresh half, and the boundary is the interesting part. */
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

/** `fetchedAt` is set either way, so a new entry holding one message cannot
    pass as a full first page past the TTL. */
export function appendCachedMessage(conversationId: string, message: MessageRecord): void {
  const existing = cache.get(conversationId);
  const appended = existing?.items ? [...existing.items, message] : [message];
  const items =
    appended.length > MAX_PER_CONVERSATION ? appended.slice(-MAX_PER_CONVERSATION) : appended;
  cache.set(conversationId, { items, fetchedAt: Date.now() });
}

/** Does nothing when the conversation is not cached: an entry from one message
    would claim a first page that is one message long. */
export function replaceCachedMessage(conversationId: string, message: MessageRecord): void {
  const existing = cache.get(conversationId);
  if (!existing?.items) return;
  cache.set(conversationId, {
    items: existing.items.map((m) => (m.message_id === message.message_id ? message : m)),
    // Not refreshed: an edit does not make the page less stale, and moving it
    // keeps a busy conversation's entry alive past a re-read.
    fetchedAt: existing.fetchedAt,
  });
}

/** A delete that skips this leaves the message on the next person's first page
    until the entry ages out, which reads as a delete that did not work. */
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
