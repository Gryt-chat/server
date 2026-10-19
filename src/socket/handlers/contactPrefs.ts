import consola from "consola";

import { directConversationId, getContactPrefs, getConversation, isContactRule, setContactPrefs } from "../../db";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth } from "../middleware/auth";
import { mayMessage } from "../utils/contactGate";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * The client writes its effective setting on every connect, so this is mostly
 * the same value again. Answered with `contact:prefs` either way.
 */

const RL_PREFS: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 12, scoreDecayMs: 3_000 };

/** A people picker asks once per open. Capped so one request can't walk the whole user table. */
const RL_REACHABLE: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 15, scoreDecayMs: 2_000 };
const MAX_REACHABLE_IDS = 500;

export function registerContactPrefsHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo, getClientIp } = ctx;

  async function answer(grytUserId: string): Promise<void> {
    socket.emit("contact:prefs", await getContactPrefs(grytUserId));
  }

  return {
    "contact:prefs:get": async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload);
        if (!auth) return;
        await answer(auth.tokenPayload.grytUserId);
      } catch (err) {
        consola.error("contact:prefs:get failed", err);
        socket.emit("server:error", { error: "contact_prefs_failed" });
      }
    },

    "contact:prefs:set": async (payload: { accessToken: string; messages?: unknown; calls?: unknown }) => {
      try {
        const rl = checkRateLimit("contact:prefs:set", clientsInfo[clientId]?.serverUserId, getClientIp(), RL_PREFS);
        if (!rl.allowed) {
          socket.emit("server:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs });
          return;
        }
        if (!payload || !isContactRule(payload.messages) || !isContactRule(payload.calls)) {
          socket.emit("server:error", { error: "invalid_payload" });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        await setContactPrefs(auth.tokenPayload.grytUserId, { messages: payload.messages, calls: payload.calls });
        await answer(auth.tokenPayload.grytUserId);
      } catch (err) {
        consola.error("contact:prefs:set failed", err);
        socket.emit("server:error", { error: "contact_prefs_failed" });
      }
    },

    /* GRYT-1815: which of these people a DM or group add would reach, so pickers
       leave out whoever would refuse. A conversation you already have counts. */
    "contact:reachable": async (payload: { accessToken: string; ids?: unknown }) => {
      try {
        const rl = checkRateLimit("contact:reachable", clientsInfo[clientId]?.serverUserId, getClientIp(), RL_REACHABLE);
        if (!rl.allowed) {
          socket.emit("server:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs });
          return;
        }
        const ids = payload?.ids;
        if (!Array.isArray(ids) || ids.length > MAX_REACHABLE_IDS || !ids.every((id) => typeof id === "string")) {
          socket.emit("server:error", { error: "invalid_payload" });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;
        const self = auth.tokenPayload.serverUserId;

        const reachable: string[] = [];
        for (const id of new Set(ids as string[])) {
          if (id === self) continue;
          if ((await getConversation(directConversationId(self, id))) || (await mayMessage(self, id))) reachable.push(id);
        }
        socket.emit("contact:reachable", { ids: reachable });
      } catch (err) {
        consola.error("contact:reachable failed", err);
        socket.emit("server:error", { error: "contact_reachable_failed" });
      }
    },
  };
}
