import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId, setUserDmKeyBinding, setUserDmKeyReset, setUserDmKeySeen } from "../../db";
import { dmBindingIdentity, handoverValid, KEY_RESET_DELAY_MS, keyResetDueAt } from "../../services/personKeyBinding";
import { pushNotify } from "../../services/push";
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

export { KEY_RESET_DELAY_MS };

/** Every connect republishes, so this only stops a write per connect. */
const SEEN_WRITE_EVERY_MS = 60 * 60 * 1000;

interface HandoverAsk { binding: string; deviceName: string; askerId: string; at: number }
/* Per server and account, the requests still waiting, so a phone that connects late gets them. */
const pendingAsks = new Map<string, HandoverAsk[]>();

function liveAsks(key: string, now = Date.now()): HandoverAsk[] {
  const live = (pendingAsks.get(key) ?? []).filter((a) => now - a.at < KEY_RESET_DELAY_MS);
  if (live.length) pendingAsks.set(key, live);
  else pendingAsks.delete(key);
  return live;
}

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

  const emitToAccount = (serverUserId: string, event: string, body: object) => {
    for (const [cid, ci] of Object.entries(clientsInfo)) {
      if (ci.serverUserId === serverUserId) io.sockets.sockets.get(cid)?.emit(event, body);
    }
  };

  return {
    "dm:key:publish": async (payload: { binding?: string | null; replace?: boolean; handover?: string; deviceName?: string }, ack?: (reply: { ok: boolean; changed?: boolean; error?: string; message?: string }) => void) => {
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

      // One identity per account (GRYT-1868): a device with its own key links instead of taking over.
      if (binding !== null && user.dm_key_binding) {
        const [had, sent] = await Promise.all([dmBindingIdentity(user.dm_key_binding), dmBindingIdentity(binding)]);
        if (had && sent !== had && payload?.replace !== true) {
          reply({ ok: false, error: "other_identity", message: "Your account already has a different key here. Link this device from one you use." });
          return;
        }
        // Only the key being replaced can hand over (GRYT-1886); the password alone isn't enough.
        const resetDue = user.dm_key_reset_binding === binding && (keyResetDueAt(user) ?? Infinity) <= Date.now();
        if (had && sent !== had && !resetDue && !(typeof payload?.handover === "string" && await handoverValid(payload.handover, user.dm_key_binding, binding))) {
          reply({ ok: false, error: "handover_required", message: "Approve this from a device that has your current key here." });
          return;
        }
      }

      const askKey = `${serverId}:${serverUserId}`;
      await setUserDmKeyBinding(serverUserId, binding);
      if (user.dm_key_reset_binding) await setUserDmKeyReset(serverUserId, null, null);
      // Approving publishes the asker's key, so the name is the asker's.
      const asker = liveAsks(askKey).find((a) => a.binding === binding);
      if (binding) await setUserDmKeySeen(serverUserId, Date.now(), asker ? asker.deviceName || null : deviceName);
      if (pendingAsks.has(askKey)) pendingAsks.set(askKey, liveAsks(askKey).filter((a) => a.binding !== binding));
      reply({ ok: true, changed: true });

      // The list is deduped on its contents and the binding is in that hash, so
      // a publish that changed nothing sends nothing.
      broadcastMemberList(io, clientsInfo, serverId);
    },

    /**
     * A device with its own key asks your other devices to hand this server over to it. The ask is
     * also a reset (GRYT-1886), so it finishes alone if nobody with the current key says no.
     */
    "dm:key:handover:ask": async (payload: { binding?: string; deviceName?: string }, ack?: (reply: { ok: boolean; at?: number; holder?: string | null; seenAt?: number | null }) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      const binding = payload?.binding;
      if (!serverUserId || typeof binding !== "string" || binding.length > MAX_BINDING_BYTES || !COMPACT_JWT.test(binding)) return;
      if (!checkRateLimit("dm:key:handover:ask", serverUserId, getClientIp(), RL_DM_KEY).allowed) return;
      const deviceName = typeof payload?.deviceName === "string" ? payload.deviceName.slice(0, 64) : "";
      const key = `${serverId}:${serverUserId}`;
      pendingAsks.set(key, [...liveAsks(key).filter((a) => a.askerId !== clientId).slice(-4), { binding, deviceName, askerId: clientId, at: Date.now() }]);
      for (const [cid, ci] of Object.entries(clientsInfo)) {
        if (cid !== clientId && ci.serverUserId === serverUserId) {
          io.sockets.sockets.get(cid)?.emit("dm:key:handover:asked", { binding, deviceName, askerId: clientId });
        }
      }
      pushNotify(clientsInfo, [serverUserId], "approve", `handover:${serverUserId}`, { evenIfPresent: true });

      const user = await getUserByServerId(serverUserId);
      const [had, sent] = user?.dm_key_binding ? await Promise.all([dmBindingIdentity(user.dm_key_binding), dmBindingIdentity(binding)]) : [null, null];
      if (!user || !sent || sent === had) return reply({ ok: false });
      // Same rule as a reset: asking again doesn't restart the clock.
      if (user.dm_key_reset_binding !== binding || !user.dm_key_reset_at) {
        await setUserDmKeyReset(serverUserId, binding, Date.now() + KEY_RESET_DELAY_MS);
      }
      const after = await getUserByServerId(serverUserId);
      const at = after ? keyResetDueAt(after) : null;
      reply({ ok: true, at: at ?? undefined, holder: user.dm_key_holder, seenAt: user.dm_key_seen_at });
      emitToAccount(serverUserId, "dm:key:reset:pending", { at });
      broadcastMemberList(io, clientsInfo, serverId);
    },

    /** A device that just connected asks for requests made while it was away, even if the asker has gone since. */
    "dm:key:handover:pending": () => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      if (!serverUserId) return;
      for (const ask of liveAsks(`${serverId}:${serverUserId}`)) {
        if (ask.askerId === clientId) continue;
        io.sockets.sockets.get(clientId)?.emit("dm:key:handover:asked", { binding: ask.binding, deviceName: ask.deviceName, askerId: ask.askerId });
      }
    },

    /** No device and no words: this binding takes over in 30 days, unless a device with the current key cancels. */
    "dm:key:reset:request": async (payload: { binding?: string }, ack?: (reply: { ok: boolean; at?: number; error?: string }) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      const binding = payload?.binding;
      if (!serverUserId || typeof binding !== "string" || binding.length > MAX_BINDING_BYTES || !COMPACT_JWT.test(binding)) return;
      if (!checkRateLimit("dm:key:reset", serverUserId, getClientIp(), RL_DM_KEY).allowed) return;
      const user = await getUserByServerId(serverUserId);
      if (!user || !(await dmBindingIdentity(binding))) return reply({ ok: false, error: "invalid_binding" });
      // A second request doesn't restart the clock, or a thief could keep yours from ever finishing.
      if (user.dm_key_reset_binding !== binding || !user.dm_key_reset_at) await setUserDmKeyReset(serverUserId, binding, Date.now() + KEY_RESET_DELAY_MS);
      const after = await getUserByServerId(serverUserId);
      const at = (after && keyResetDueAt(after)) ?? Date.now() + KEY_RESET_DELAY_MS;
      reply({ ok: true, at });
      emitToAccount(serverUserId, "dm:key:reset:pending", { at });
      broadcastMemberList(io, clientsInfo, serverId);
    },

    /** "That wasn't me": proven by a note from the current key handing over to itself. */
    "dm:key:reset:cancel": async (payload: { proof?: string }, ack?: (reply: { ok: boolean; error?: string }) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      if (!serverUserId || typeof payload?.proof !== "string") return;
      const user = await getUserByServerId(serverUserId);
      if (!user?.dm_key_reset_binding) return reply({ ok: true });
      if (!user.dm_key_binding || !(await handoverValid(payload.proof, user.dm_key_binding, user.dm_key_binding))) {
        return reply({ ok: false, error: "proof_required" });
      }
      await setUserDmKeyReset(serverUserId, null, null);
      reply({ ok: true });
      emitToAccount(serverUserId, "dm:key:reset:pending", { at: null });
      broadcastMemberList(io, clientsInfo, serverId);
    },

    /** "That isn't mine": tells the asking device, so it stops waiting. */
    "dm:key:handover:deny": (payload: { askerId?: string }) => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      const askerId = payload?.askerId;
      const key = `${serverId}:${serverUserId}`;
      if (!serverUserId || typeof askerId !== "string" || !liveAsks(key).some((a) => a.askerId === askerId)) return;
      pendingAsks.set(key, liveAsks(key).filter((a) => a.askerId !== askerId));
      io.sockets.sockets.get(askerId)?.emit("dm:key:handover:denied", {});
    },
  };
}
