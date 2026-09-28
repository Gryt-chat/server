import consola from "consola";

import { getUserByServerId, setUserPersonKeyBinding } from "../../db";
import { checkPersonKeyBinding } from "../../services/personKeyBinding";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth } from "../middleware/auth";
import { broadcastMemberList } from "../utils/clients";
import type { EventHandlerMap, HandlerContext } from "./types";

type Reply = Record<string, unknown> & { ok: boolean };
type Ack = (reply: Reply) => void;

/** Derived from the seed, so it's sent on arrival and rarely again. dm:key:publish's budget. */
const RL_PERSON_KEY: RateLimitRule = { limit: 5, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 30_000 };

const fail = (error: string, message: string, extra: Record<string, unknown> = {}): Reply => ({
  ok: false,
  error,
  message,
  ...extra,
});

export function registerMlsPersonKeyHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, clientsInfo, serverId, getClientIp } = ctx;

  return {
    /** Publish, replace or (with null) withdraw your person key binding on this server. */
    "mls:person:publish": async (payload: { accessToken?: string; binding?: string | null }, ack: Ack) => {
      ack = typeof ack === "function" ? ack : () => {};
      try {
        const rl = checkRateLimit("mls:person:publish", clientsInfo[clientId]?.serverUserId, getClientIp(), RL_PERSON_KEY);
        if (!rl.allowed) {
          ack(fail("rate_limited", `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`, { retryAfterMs: rl.retryAfterMs }));
          return;
        }
        if (!payload || typeof payload !== "object") {
          ack(fail("invalid_payload", "Invalid payload"));
          return;
        }
        const auth = await requireAuth(socket, payload);
        if (!auth) {
          ack(fail("unauthenticated", "Sign in to this server first."));
          return;
        }

        const binding = payload.binding;
        if (binding !== null && typeof binding !== "string") {
          ack(fail("invalid_payload", "binding has to be a string, or null to withdraw it."));
          return;
        }

        const serverUserId = auth.tokenPayload.serverUserId;
        const user = await getUserByServerId(serverUserId);
        if (!user) {
          ack(fail("unknown_member", "User not found. Please rejoin."));
          return;
        }

        if (binding !== null) {
          const check = await checkPersonKeyBinding(binding, user.dm_key_binding);
          if (!check.ok) {
            ack(fail(check.error, check.message));
            return;
          }
        }

        if (user.person_key_binding === binding) {
          ack({ ok: true, changed: false });
          return;
        }
        await setUserPersonKeyBinding(serverUserId, binding);
        ack({ ok: true, changed: true });

        // The binding is in the member list's dedupe hash, so this reaches people.
        broadcastMemberList(io, clientsInfo, serverId);
      } catch (err) {
        consola.error("mls:person:publish failed", err);
        ack(fail("failed", "Could not store the person key binding"));
      }
    },
  };
}
