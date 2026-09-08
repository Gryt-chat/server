import type { HandlerContext, EventHandlerMap } from "./types";
import { listUnseenMentions, markMentionsSeen } from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { resolveConversationAccess } from "../utils/conversationAccess";

const RL_LIST: RateLimitRule = { limit: 20, windowMs: 30_000, scorePerAction: 0.5, maxScore: 8, scoreDecayMs: 2000 };
const RL_SEEN: RateLimitRule = { limit: 60, windowMs: 60_000, scorePerAction: 0.3, maxScore: 10, scoreDecayMs: 1500 };

export function registerMentionHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo, getClientIp } = ctx;

  /** A row says somebody was named at the time, not that they can still see the
      conversation. Filtered on read, because a gate can be given back. */
  async function visible(serverUserId: string) {
    const rows = await listUnseenMentions(serverUserId);
    const allowed = await Promise.all(
      rows.map((r) => resolveConversationAccess(r.conversation_id, serverUserId)),
    );
    return rows.filter((_, i) => allowed[i].allowed);
  }

  return {
    /** The whole list rather than a count: the client draws a badge and a list
        behind it, so a separate count is the same query twice. */
    "mentions:list": async () => {
      const userId = clientsInfo[clientId]?.serverUserId;
      if (!userId || userId.startsWith("temp_")) return;

      const rl = checkRateLimit("mentions:list", userId, getClientIp(), RL_LIST);
      if (!rl.allowed) return;

      const mentions = await visible(userId);

      /* Both: a mention in a thread still belongs to its channel, and the badge
         is how somebody notices while the thread count is how they find it. */
      const counts: Record<string, number> = {};
      const threadCounts: Record<string, number> = {};
      for (const m of mentions) {
        counts[m.conversation_id] = (counts[m.conversation_id] ?? 0) + 1;
        if (m.thread_id) threadCounts[m.thread_id] = (threadCounts[m.thread_id] ?? 0) + 1;
      }

      socket.emit("mentions:list", { mentions, counts, threadCounts });
    },

    /** A conversation clears its timeline, a thread that thread, `includeThreads`
        both, and nothing the lot. The reply carries the list back. */
    "mentions:seen": async (
      payload:
        | { conversationId?: string; threadId?: string; includeThreads?: boolean }
        | undefined,
    ) => {
      const userId = clientsInfo[clientId]?.serverUserId;
      if (!userId || userId.startsWith("temp_")) return;

      const rl = checkRateLimit("mentions:seen", userId, getClientIp(), RL_SEEN);
      if (!rl.allowed) return;

      const conversationId = payload?.conversationId;
      if (conversationId) {
        // Checked here too, or a guessed id says whether anything unseen existed
        // there by how the count changed.
        const access = await resolveConversationAccess(conversationId, userId);
        if (!access.allowed) return;
      }

      /* A thread on its own is not a thing you can read: the gate above is on
         the conversation, so the thread only means anything alongside one, and
         neither does asking for a conversation's threads without the
         conversation (GRYT-1030). */
      await markMentionsSeen({
        serverUserId: userId,
        conversationId,
        threadId: conversationId ? payload?.threadId : undefined,
        includeThreads: conversationId ? payload?.includeThreads : undefined,
      });

      const mentions = await visible(userId);
      const counts: Record<string, number> = {};
      const threadCounts: Record<string, number> = {};
      for (const m of mentions) {
        if (m.thread_id) threadCounts[m.thread_id] = (threadCounts[m.thread_id] ?? 0) + 1;
        counts[m.conversation_id] = (counts[m.conversation_id] ?? 0) + 1;
      }

      socket.emit("mentions:list", { mentions, counts, threadCounts });
    },
  };
}
