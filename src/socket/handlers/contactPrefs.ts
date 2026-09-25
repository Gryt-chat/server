import consola from "consola";

import { getContactPrefs, isContactRule, setContactPrefs } from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth } from "../middleware/auth";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * The client writes its effective setting on every connect, so this is mostly
 * the same value again. Answered with `contact:prefs` either way.
 */

const RL_PREFS: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 12, scoreDecayMs: 3_000 };

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
  };
}
