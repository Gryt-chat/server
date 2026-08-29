import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, setUserDmKeyBinding } from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { broadcastMemberList } from "../utils/clients";

/**
 * Where a member leaves their DM public key (GRYT-720).
 *
 * The client signs a short JWT with the identity key it joined on, carrying its
 * X25519 public key, and sends it here. It goes in a column and comes back out
 * in the member list. Nothing on this side reads it.
 *
 * That is the whole design rather than a shortcut. The feature exists so this
 * server cannot read the messages, and a server that verified the binding would
 * be vouching for something every member has to check for itself anyway — so
 * verifying here would buy nothing and would invite somebody to rely on it.
 * Members pin what they are handed and refuse a change; see `server-pins.ts` on
 * the client, which does the same three moves for server keys.
 *
 * ## What is checked, and why only this much
 *
 * A length cap and a shape that could plausibly be a compact JWT. Both are
 * about this server's own storage rather than about anybody's security: without
 * them a member could park a megabyte of anything in a column that goes out to
 * every other member on every member-list broadcast.
 */

/**
 * Generous next to a real binding, which is a header with a P-256 JWK in it, a
 * payload with a scope and 32 base64url bytes, and a signature — comfortably
 * under 1 kB. Room for a longer scope and a future field, and nowhere near
 * enough to be worth using as storage.
 */
const MAX_BINDING_BYTES = 4096;

/** Three non-empty base64url segments. Not a verification, a shape. */
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Rare on purpose. A binding is derived from a seed and a scope, so a member
 * sends one when they arrive and then never again unless their identity
 * changed. Anything faster is a client with a loop in it.
 */
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
    "dm:key:publish": async (payload: { binding?: string | null }) => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      if (!serverUserId) return;

      const rl = checkRateLimit("dm:key:publish", serverUserId, getClientIp(), RL_DM_KEY);
      if (!rl.allowed) return;

      const user = await getUserByServerId(serverUserId);
      if (!user) return;

      const binding = payload?.binding ?? null;

      // Null is a real thing to send: a client that no longer has an identity to
      // sign one with says so, rather than leaving a key nobody holds behind for
      // people to keep encrypting to.
      if (binding !== null) {
        if (typeof binding !== "string") return;
        if (binding.length > MAX_BINDING_BYTES) return;
        if (!COMPACT_JWT.test(binding)) return;
      }

      if (user.dm_key_binding === binding) return;

      await setUserDmKeyBinding(serverUserId, binding);

      // So the other members see it without waiting for something else to move.
      // The list is deduped on its own contents, and the binding is part of that
      // hash, so a publish that changed nothing sends nothing.
      broadcastMemberList(io, clientsInfo, serverId);
    },
  };
}
