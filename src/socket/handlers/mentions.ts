import type { HandlerContext, EventHandlerMap } from "./types";
import { listUnseenMentions, markMentionsSeen } from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { resolveConversationAccess } from "../utils/conversationAccess";

const RL_LIST: RateLimitRule = { limit: 20, windowMs: 30_000, scorePerAction: 0.5, maxScore: 8, scoreDecayMs: 2000 };
const RL_SEEN: RateLimitRule = { limit: 60, windowMs: 60_000, scorePerAction: 0.3, maxScore: 10, scoreDecayMs: 1500 };

export function registerMentionHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo, getClientIp } = ctx;

  /**
   * The mentions this person may still be told about.
   *
   * A row records that somebody was named in a conversation at the time. It
   * does not promise they can still see that conversation: a channel can be
   * given a view gate afterwards, and a moderator can lose a role. Handing back
   * an unfiltered list would name a channel to somebody who can no longer open
   * it, and clicking the badge would land on a refusal.
   *
   * Filtered on read rather than deleted on the gate change, because the gate
   * can be given back — and a mention that was quietly deleted while a channel
   * was private would not come back with it.
   */
  async function visible(serverUserId: string) {
    const rows = await listUnseenMentions(serverUserId);
    const allowed = await Promise.all(
      rows.map((r) => resolveConversationAccess(r.conversation_id, serverUserId)),
    );
    return rows.filter((_, i) => allowed[i].allowed);
  }

  return {
    /**
     * Everything waiting, on connect and on demand.
     *
     * The whole list rather than a count, because the client draws both — a
     * badge on each channel and a list behind it — and asking for the count
     * separately would be the same query twice.
     */
    "mentions:list": async () => {
      const userId = clientsInfo[clientId]?.serverUserId;
      if (!userId || userId.startsWith("temp_")) return;

      const rl = checkRateLimit("mentions:list", userId, getClientIp(), RL_LIST);
      if (!rl.allowed) return;

      const mentions = await visible(userId);

      const counts: Record<string, number> = {};
      for (const m of mentions) {
        counts[m.conversation_id] = (counts[m.conversation_id] ?? 0) + 1;
      }

      socket.emit("mentions:list", { mentions, counts });
    },

    /**
     * They have read them.
     *
     * Passing a conversation clears that one, passing nothing clears the lot.
     * The reply carries the list again rather than a bare acknowledgement, so
     * two devices belonging to the same person cannot end up disagreeing about
     * what is left.
     */
    "mentions:seen": async (payload: { conversationId?: string } | undefined) => {
      const userId = clientsInfo[clientId]?.serverUserId;
      if (!userId || userId.startsWith("temp_")) return;

      const rl = checkRateLimit("mentions:seen", userId, getClientIp(), RL_SEEN);
      if (!rl.allowed) return;

      const conversationId = payload?.conversationId;
      if (conversationId) {
        // Marking is a write, so the gate is checked here too. Without it a
        // guessed id would say whether anything unseen existed there, by way
        // of how the count changed.
        const access = await resolveConversationAccess(conversationId, userId);
        if (!access.allowed) return;
      }

      await markMentionsSeen(userId, conversationId);

      const mentions = await visible(userId);
      const counts: Record<string, number> = {};
      for (const m of mentions) {
        counts[m.conversation_id] = (counts[m.conversation_id] ?? 0) + 1;
      }

      socket.emit("mentions:list", { mentions, counts });
    },
  };
}
