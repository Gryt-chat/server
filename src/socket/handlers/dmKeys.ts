import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, setUserDmKeyBinding, setUserDmKeySeen } from "../../db";
import { dmBindingIdentity } from "../../services/personKeyBinding";
import { pushNotify } from "../../services/push";
import { checkRateLimit, type RateLimitRule } from "../../utils/rateLimiter";
import { broadcastMemberList } from "../utils/clients";
import { calculateJwkThumbprint, EmbeddedJWK, type JWK, jwtVerify } from "jose";

/**
 * A column in, the member list out, and nothing on this side reads it: verifying
 * would vouch for what every member has to check itself.
 */

/** A real binding is comfortably under 1 kB. Room for a longer scope, and
    nowhere near enough to be worth using as storage. */
const MAX_BINDING_BYTES = 4096;

/** Three non-empty base64url segments. Not a verification, a shape. */
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Signed by the account key this device's certificate names, over the binding it publishes. */
export async function provesAccountKey(proof: string | undefined, binding: string, accountKey: string | undefined): Promise<boolean> {
  if (!accountKey || typeof proof !== "string" || proof.length > MAX_BINDING_BYTES) return false;
  try {
    const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, { algorithms: ["ES256"] });
    return payload.binding === binding && (await calculateJwkThumbprint(protectedHeader.jwk as JWK)) === accountKey;
  } catch {
    return false;
  }
}

/** Every connect republishes, so this only stops a write per connect. */
const SEEN_WRITE_EVERY_MS = 60 * 60 * 1000;

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
    "dm:key:publish": async (payload: { binding?: string | null; replace?: boolean; deviceName?: string; account?: string }, ack?: (reply: { ok: boolean; changed?: boolean; error?: string; message?: string }) => void) => {
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

      const deviceName = typeof payload?.deviceName === "string" ? payload.deviceName.slice(0, 64) || null : null;
      const seen = async () => {
        if (Date.now() - (user.dm_key_seen_at ?? 0) > SEEN_WRITE_EVERY_MS || (deviceName && deviceName !== user.dm_key_holder)) {
          await setUserDmKeySeen(serverUserId, Date.now(), deviceName ?? user.dm_key_holder);
        }
      };

      if (user.dm_key_binding === binding) {
        if (binding) await seen();
        reply({ ok: true, changed: false });
        return;
      }

      // One identity per account (GRYT-1868): only a device proving the account key replaces another key.
      if (binding !== null && user.dm_key_binding) {
        const [had, sent] = await Promise.all([dmBindingIdentity(user.dm_key_binding), dmBindingIdentity(binding)]);
        if (had && sent !== had && payload?.replace !== true) {
          reply({ ok: false, error: "other_identity", message: "Your account already has a different key here. Link this device from one you use." });
          return;
        }
        if (had && sent !== had && !(await provesAccountKey(payload?.account, binding, user.account_key ?? undefined))) {
          reply({ ok: false, error: "handover_required", message: "This device can't show it has your account's key." });
          return;
        }
      }

      await setUserDmKeyBinding(serverUserId, binding);
      if (binding) await setUserDmKeySeen(serverUserId, Date.now(), deviceName);
      reply({ ok: true, changed: true });

      // The list is deduped on its contents and the binding is in that hash, so
      // a publish that changed nothing sends nothing.
      broadcastMemberList(io, clientsInfo, serverId);
    },

    /** A device waiting to be approved: your other devices here show a prompt. The ticket is the identity service's; devices check it. */
    "device:approve:ask": async (payload: { ticket?: string }) => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      const ticket = payload?.ticket;
      if (!serverUserId || typeof ticket !== "string" || ticket.length > 2048 || !COMPACT_JWT.test(ticket)) return;
      if (!checkRateLimit("device:approve:ask", serverUserId, getClientIp(), RL_DM_KEY).allowed) return;
      for (const [cid, ci] of Object.entries(clientsInfo)) {
        if (cid !== clientId && ci.serverUserId === serverUserId) io.sockets.sockets.get(cid)?.emit("device:approve:asked", { askId: clientId, ticket });
      }
      pushNotify(clientsInfo, [serverUserId], "approve", `device:${serverUserId}`, { evenIfPresent: true });
    },

    /** "Not me": tells the waiting device, which must be on the same account. */
    "device:approve:deny": async (payload: { askId?: string }) => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      const askId = payload?.askId;
      if (!serverUserId || typeof askId !== "string" || clientsInfo[askId]?.serverUserId !== serverUserId) return;
      io.sockets.sockets.get(askId)?.emit("device:approve:denied", {});
    },
  };
}
