import consola from "consola";

import { removePushDevice, savePushDevice } from "../../db";
import { CAPABILITY_SHAPE, pushEnabled } from "../../services/push";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth } from "../middleware/auth";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * A phone hands over the capability the relay gave it for this server, and says
 * when it goes to the background (GRYT-1656).
 */

type Reply = { ok: true } | { ok: false; error: string };
type Ack = (reply: Reply) => void;

const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MUTED = 1000;

/** Conversation ids the phone muted. Null when it is not a short list of short strings. */
function mutedFrom(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_MUTED) return null;
  if (!raw.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) return null;
  return [...new Set(raw as string[])];
}
const RL_REGISTER: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 12, scoreDecayMs: 3_000 };

export function registerPushHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo, getClientIp } = ctx;

  function limited(event: string): boolean {
    return !checkRateLimit(event, clientsInfo[clientId]?.serverUserId, getClientIp(), RL_REGISTER).allowed;
  }

  return {
    "push:register": async (
      payload: { accessToken: string; installId?: unknown; capability?: unknown; muted?: unknown },
      ack: Ack,
    ) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        if (!pushEnabled()) return ack({ ok: false, error: "push_off" });
        if (limited("push:register")) return ack({ ok: false, error: "rate_limited" });
        if (!payload || typeof payload.installId !== "string" || !INSTALL_ID.test(payload.installId)
          || typeof payload.capability !== "string" || !CAPABILITY_SHAPE.test(payload.capability)) {
          return ack({ ok: false, error: "invalid_payload" });
        }
        const muted = mutedFrom(payload.muted);
        if (!muted) return ack({ ok: false, error: "invalid_payload" });
        const auth = await requireAuth(socket, payload);
        if (!auth) return ack({ ok: false, error: "unauthorized" });
        savePushDevice(auth.tokenPayload.serverUserId, payload.installId, payload.capability, muted);
        ack({ ok: true });
      } catch (err) {
        consola.error("push:register failed", err);
        ack({ ok: false, error: "failed" });
      }
    },

    "push:unregister": async (payload: { accessToken: string; installId?: unknown }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        if (limited("push:unregister")) return ack({ ok: false, error: "rate_limited" });
        if (!payload || typeof payload.installId !== "string" || !INSTALL_ID.test(payload.installId)) {
          return ack({ ok: false, error: "invalid_payload" });
        }
        const auth = await requireAuth(socket, payload);
        if (!auth) return ack({ ok: false, error: "unauthorized" });
        removePushDevice(auth.tokenPayload.serverUserId, payload.installId);
        ack({ ok: true });
      } catch (err) {
        consola.error("push:unregister failed", err);
        ack({ ok: false, error: "failed" });
      }
    },

    /* Only this socket's own flag, so no token: lying about it only changes whether you get pushed. */
    "push:presence": (payload: { background?: unknown }) => {
      const info = clientsInfo[clientId];
      if (info && typeof payload?.background === "boolean") info.appInBackground = payload.background;
    },
  };
}
