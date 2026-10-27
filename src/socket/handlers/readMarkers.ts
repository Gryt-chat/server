import type { HandlerContext, EventHandlerMap } from "./types";
import { countUnreadByConversation, listReadMarkers, setReadMarker } from "../../db";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { resolveConversationAccess } from "../utils/conversationAccess";

/* `read:set` is per channel opened, so it is allowed more than a list. Both follow
   mentions, which is the same shape of traffic from the same clients. */
const RL_LIST: RateLimitRule = { limit: 20, windowMs: 30_000, scorePerAction: 0.5, maxScore: 8, scoreDecayMs: 2000 };
const RL_SET: RateLimitRule = { limit: 60, windowMs: 60_000, scorePerAction: 0.3, maxScore: 10, scoreDecayMs: 1500 };

export function registerReadMarkerHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo, getClientIp } = ctx;

  /**
   * Markers and counts in one reply: a client that has history counts for itself, and
   * one that has just installed has none to count.
   */
  async function sendState(userId: string) {
    const [markers, counts] = await Promise.all([
      listReadMarkers(userId),
      countUnreadByConversation(userId),
    ]);

    /* Filtered on read, as mentions are: a marker says where somebody got to, not that
       the conversation is still theirs to see. A gate can be taken away and given back. */
    const allowed = await Promise.all(
      markers.map((m) => resolveConversationAccess(m.conversation_id, userId)),
    );
    const visible = markers.filter((_, i) => allowed[i].allowed);

    const open = new Set(visible.map((m) => m.conversation_id));
    const open_counts: Record<string, number> = {};
    for (const [id, n] of Object.entries(counts)) {
      if (open.has(id)) open_counts[id] = n;
    }

    socket.emit("read:list", { markers: visible, counts: open_counts });
  }

  return {
    /** Everything this person has read up to, and how much has arrived since. */
    "read:list": async () => {
      const userId = clientsInfo[clientId]?.serverUserId;
      if (!userId || userId.startsWith("temp_")) return;

      const rl = checkRateLimit("read:list", userId, getClientIp(), RL_LIST);
      if (!rl.allowed) return;

      await sendState(userId);
    },

    /**
     * Read up to a message, or with none, everything there. The reply carries the whole state back, so two devices in
     * the same account converge without either guessing what the other did.
     */
    "read:set": async (payload: { conversationId?: string; messageId?: string } | undefined) => {
      const userId = clientsInfo[clientId]?.serverUserId;
      if (!userId || userId.startsWith("temp_")) return;

      const rl = checkRateLimit("read:set", userId, getClientIp(), RL_SET);
      if (!rl.allowed) return;

      const { conversationId, messageId } = payload ?? {};
      if (!conversationId) return;

      /* Before the write, or a guessed conversation id tells you whether a message is
         in it by whether the marker moved. */
      const access = await resolveConversationAccess(conversationId, userId);
      // A DM's marker would be a read receipt on an encrypted message.
      if (!access.allowed || access.kind !== "channel") return;

      await setReadMarker({ serverUserId: userId, conversationId, messageId });

      await sendState(userId);
    },
  };
}
