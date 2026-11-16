import type { HandlerContext, EventHandlerMap } from "./types";
import { addDmKeyAsk, getUserByServerId, listDmKeyAsks, removeDmKeyAsk, setUserDmKeyBinding, setUserDmKeyHandover, setUserDmKeyReset, setUserDmKeySeen } from "../../db";
import { dmBindingIdentity, handoverValid, KEY_RESET_DELAY_MS, keyResetDueAt } from "../../services/personKeyBinding";
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

export { KEY_RESET_DELAY_MS };

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

/* An ask is named by the asking key, not a socket id, so it means the same after a restart. Older
   clients read that name as `askerId`. */
const asked = (ask: { binding: string; deviceName: string }) => ({ binding: ask.binding, deviceName: ask.deviceName, askerId: ask.binding });

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
    "dm:key:publish": async (payload: { binding?: string | null; replace?: boolean; handover?: string; deviceName?: string; account?: string }, ack?: (reply: { ok: boolean; changed?: boolean; error?: string; message?: string }) => void) => {
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

      const note = typeof payload?.handover === "string" ? payload.handover : null;
      let handedOver = false;
      // One identity per account (GRYT-1868): a device with its own key links instead of taking over.
      if (binding !== null && user.dm_key_binding) {
        const [had, sent] = await Promise.all([dmBindingIdentity(user.dm_key_binding), dmBindingIdentity(binding)]);
        if (had && sent !== had && payload?.replace !== true) {
          reply({ ok: false, error: "other_identity", message: "Your account already has a different key here. Link this device from one you use." });
          return;
        }
        // Only the key being replaced can hand over (GRYT-1886); the password alone isn't enough.
        const resetDue = user.dm_key_reset_binding === binding && (keyResetDueAt(user) ?? Infinity) <= Date.now();
        handedOver = !!had && sent !== had && note !== null && await handoverValid(note, user.dm_key_binding, binding);
        // The account's one key takes the server over with no older device's say; contacts compare codes once.
        const accountMove = !!had && sent !== had && !handedOver && await provesAccountKey(payload?.account, binding, user.account_key ?? undefined);
        if (had && sent !== had && !resetDue && !handedOver && !accountMove) {
          reply({ ok: false, error: "handover_required", message: "Approve this from a device that has your current key here." });
          return;
        }
      }

      await setUserDmKeyBinding(serverUserId, binding);
      // Contacts follow a signed handover without asking; any other change leaves them to compare codes.
      await setUserDmKeyHandover(serverUserId, handedOver ? note : null, handedOver ? user.dm_key_binding : null);
      if (user.dm_key_reset_binding) await setUserDmKeyReset(serverUserId, null, null);
      // Approving publishes the asker's key, so the name is the asker's.
      const asker = binding ? (await listDmKeyAsks(serverUserId, KEY_RESET_DELAY_MS)).find((a) => a.binding === binding) : undefined;
      if (binding) await setUserDmKeySeen(serverUserId, Date.now(), asker ? asker.deviceName || null : deviceName);
      if (asker) await removeDmKeyAsk(serverUserId, asker.binding);
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
      const user = await getUserByServerId(serverUserId);
      const [had, sent] = user?.dm_key_binding ? await Promise.all([dmBindingIdentity(user.dm_key_binding), dmBindingIdentity(binding)]) : [null, null];
      if (!user || !sent || sent === had) return reply({ ok: false });

      await addDmKeyAsk(serverUserId, binding, deviceName, Date.now());
      for (const [cid, ci] of Object.entries(clientsInfo)) {
        if (cid !== clientId && ci.serverUserId === serverUserId) {
          io.sockets.sockets.get(cid)?.emit("dm:key:handover:asked", { ...asked({ binding, deviceName }), holder: user.dm_key_holder ?? null });
        }
      }
      pushNotify(clientsInfo, [serverUserId], "approve", `handover:${serverUserId}`, { evenIfPresent: true });

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

    /** Which of your devices has your key here, as it named itself, so a notice can say who approves. Own account only. */
    "dm:key:holder": async (_payload: Record<string, never>, ack?: (reply: { holder: string | null; seenAt: number | null }) => void) => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      if (!serverUserId || typeof ack !== "function") return;
      if (!checkRateLimit("dm:key:holder", serverUserId, getClientIp(), RL_DM_KEY).allowed) return;
      const user = await getUserByServerId(serverUserId);
      ack({ holder: user?.dm_key_holder ?? null, seenAt: user?.dm_key_seen_at ?? null });
    },

    /** A device that just connected asks for requests made while it was away, even if the asker has gone since. */
    "dm:key:handover:pending": async () => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      if (!serverUserId) return;
      // The asking device gets its own ask back too, with who to approve it on, after a reload.
      const user = await getUserByServerId(serverUserId);
      for (const ask of await listDmKeyAsks(serverUserId, KEY_RESET_DELAY_MS)) {
        const at = user?.dm_key_reset_binding === ask.binding ? keyResetDueAt(user) ?? undefined : undefined;
        io.sockets.sockets.get(clientId)?.emit("dm:key:handover:asked", { ...asked(ask), holder: user?.dm_key_holder ?? null, seenAt: user?.dm_key_seen_at ?? null, at });
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
      await removeDmKeyAsk(serverUserId, user.dm_key_reset_binding);
      reply({ ok: true });
      emitToAccount(serverUserId, "dm:key:reset:pending", { at: null });
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

    /** "That isn't mine": tells the asking device, so it stops waiting. */
    "dm:key:handover:deny": async (payload: { askerId?: string }) => {
      const serverUserId = clientsInfo[clientId]?.serverUserId;
      const binding = payload?.askerId;
      if (!serverUserId || typeof binding !== "string") return;
      if (!(await listDmKeyAsks(serverUserId, KEY_RESET_DELAY_MS)).some((a) => a.binding === binding)) return;
      await removeDmKeyAsk(serverUserId, binding);
      // To every device on the account: the one whose key this is stops waiting.
      emitToAccount(serverUserId, "dm:key:handover:denied", { binding });
    },
  };
}
