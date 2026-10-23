import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, setUserDmKeyBinding } from "../../db";
import { dmBindingIdentity } from "../../services/personKeyBinding";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { broadcastMemberList } from "../utils/clients";

/**
 * A column in, the member list out, and nothing on this side reads it: verifying
 * would vouch for what every member has to check itself.
 */

/** A real binding is comfortably under 1 kB. Room for a longer scope, and
    nowhere near enough to be worth using as storage. */
const MAX_BINDING_BYTES = 4096;

/** Three non-empty base64url segments. Not a verification, a shape. */
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A binding is derived from a seed and a scope, so it is sent on arrival and
    then never again. Anything faster is a client with a loop in it. */
const RL_DM_KEY: RateLimitRule = {
  limit: 5,
  windowMs: 60_000,
  scorePerAction: 1,
  maxScore: 10,
  scoreDecayMs: 30_000,
};

export function registerDmKeyHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, clientId, clientsInfo, serverId, getClientIp } = ctx;

  return {
    "dm:key:publish": async (payload: { binding?: string | null; replace?: boolean }, ack?: (reply: { ok: boolean; changed?: boolean; error?: string; message?: string }) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      if (!serverUserId) return;

      const rl = checkRateLimit("dm:key:publish", serverUserId, getClientIp(), RL_DM_KEY);
      if (!rl.allowed) return;

      const user = await getUserByServerId(serverUserId);
      if (!user) return;

      const binding = payload?.binding ?? null;

      // Null is a real thing to send, rather than leaving a key nobody holds for
      // people to keep encrypting to.
      if (binding !== null) {
        if (typeof binding !== "string") return;
        if (binding.length > MAX_BINDING_BYTES) return;
        if (!COMPACT_JWT.test(binding)) return;
      }

      if (user.dm_key_binding === binding) {
        reply({ ok: true, changed: false });
        return;
      }

      // One identity per account (GRYT-1868): a device with its own key links instead of taking over.
      if (binding !== null && user.dm_key_binding && payload?.replace !== true) {
        const [had, sent] = await Promise.all([dmBindingIdentity(user.dm_key_binding), dmBindingIdentity(binding)]);
        if (had && sent !== had) {
          reply({ ok: false, error: "other_identity", message: "Your account already has a different key here. Link this device from one you use." });
          return;
        }
      }

      await setUserDmKeyBinding(serverUserId, binding);
      reply({ ok: true, changed: true });

      // The list is deduped on its contents and the binding is in that hash, so
      // a publish that changed nothing sends nothing.
      broadcastMemberList(io, clientsInfo, serverId);
    },
  };
}
