import consola from "consola";

import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth, requirePermission } from "../middleware/auth";
import {
  DENIAL_RESPONSES,
  resolveConversationAccess,
} from "../utils/conversationAccess";
import {
  endRing,
  getRing,
  ringsFrom,
  startRing,
  type CallRing,
  type RingEnd,
} from "../utils/callRings";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Ringing somebody in a direct message or a group.
 *
 * The call itself is not here, because a call is not a thing this server keeps.
 * It is an SFU room whose id is the conversation id, joined through the same
 * `voice:room:request` every channel goes through — server#88 is what makes
 * that room private to the conversation's members. So there is no `call:accept`
 * in this file: answering a call is joining the room, and the ring is stopped
 * by the join rather than by a separate message that could disagree with it.
 *
 * What is genuinely new is reaching somebody who is not looking at the
 * conversation, and then stopping. A voice channel never needs that — you go to
 * it, and whoever is there was already there.
 *
 * Every ring goes to **all** of a person's sockets, and every ending is
 * withdrawn from all of them too. Somebody with a laptop and a phone who
 * answers on the laptop should not be left with a phone ringing in their
 * pocket, and the only way to get that right is to treat the person as the
 * addressee rather than the socket.
 */

const RL_RING: RateLimitRule = { limit: 6, windowMs: 60_000, scorePerAction: 2, maxScore: 8, scoreDecayMs: 5000 };
const RL_ANSWER: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 0.5, maxScore: 8, scoreDecayMs: 2000 };

export interface IncomingCall {
  conversation_id: string;
  from: { server_user_id: string; nickname: string };
  /** When the ring gives up on its own, so a client can show the same clock. */
  expires_at: number;
}

export function registerCallHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, clientsInfo, getClientIp } = ctx;

  /** Every socket this person has open. A ring is addressed to the person. */
  function socketIdsFor(serverUserId: string): string[] {
    return Object.entries(clientsInfo)
      .filter(([, ci]) => ci.serverUserId === serverUserId)
      .map(([cid]) => cid);
  }

  function emitTo(serverUserId: string, event: string, payload: unknown): void {
    for (const cid of socketIdsFor(serverUserId)) {
      io.sockets.sockets.get(cid)?.emit(event, payload);
    }
  }

  /**
   * Tell everybody the ring reached that it has stopped, and why.
   *
   * The caller is told too. They are the one person who is not being rung, and
   * without this their client would sit on "ringing…" after a decline.
   */
  function withdraw(ring: CallRing, reason: RingEnd, endedBy?: string): void {
    const payload = { conversation_id: ring.conversationId, reason, ended_by: endedBy ?? null };
    for (const id of ring.toServerUserIds) emitTo(id, "call:withdrawn", payload);
    emitTo(ring.fromServerUserId, "call:withdrawn", payload);
  }

  return {
    /**
     * Ring everybody else in a conversation.
     *
     * Three permissions, because this is three things at once.
     *
     * It happens in a direct message, so `send_direct_messages` — a role that
     * has had direct messages taken away does not get them back through the
     * call button.
     *
     * The person starting it is about to be in a voice room, so `join_voice`.
     * Somebody who may not join voice ringing a call they cannot enter is a
     * call that can only be answered into an empty room.
     *
     * And starting a call is its own act, so `start_calls` (GRYT-712). This is
     * the one an owner reaches for to say who may place a call without saying
     * anything about who may take one — answering is `join_voice`, and it is
     * deliberately not this. Every role that could ring before the release
     * holds it, by backfill.
     */
    'call:ring': async (payload: { accessToken: string; conversationId: string }) => {
      try {
        if (!payload || typeof payload.accessToken !== "string" || typeof payload.conversationId !== "string") {
          socket.emit("call:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const rl = checkRateLimit("call:ring", clientsInfo[clientId]?.serverUserId, getClientIp(), RL_RING);
        if (!rl.allowed) {
          socket.emit("call:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "send_direct_messages" });
        if (!auth) return;

        const self = auth.tokenPayload.serverUserId;

        // The other two, through the shared helper so a refusal reads the same
        // as the one the door would have given.
        if (!requirePermission(socket, auth, "start_calls")) return;
        if (!requirePermission(socket, auth, "join_voice")) return;

        const access = await resolveConversationAccess(payload.conversationId, self);
        if (!access.allowed) {
          const denial = DENIAL_RESPONSES[access.reason];
          socket.emit("call:error", { error: denial.error, message: denial.message });
          return;
        }
        if (access.kind !== "dm") {
          // A channel is always there and nobody has to be told about it.
          socket.emit("call:error", { error: "not_a_conversation", message: "A channel does not need ringing — just join it." });
          return;
        }

        const others = access.memberIds.filter((id) => id !== self);
        if (others.length === 0) {
          socket.emit("call:error", { error: "nobody_to_ring", message: "There is nobody else in this conversation" });
          return;
        }

        const ring = startRing(
          { conversationId: payload.conversationId, fromServerUserId: self, toServerUserIds: others },
          Date.now(),
          (expired) => withdraw(expired, "timeout"),
        );

        if (!ring) {
          // Somebody else is already ringing this conversation. Two people
          // pressing call at once is one call, and restarting the clock on
          // theirs would make a ring that never times out.
          socket.emit("call:error", { error: "already_ringing", message: "This conversation is already ringing" });
          return;
        }

        const incoming: IncomingCall = {
          conversation_id: ring.conversationId,
          from: { server_user_id: self, nickname: clientsInfo[clientId]?.nickname || auth.tokenPayload.nickname || "" },
          expires_at: ring.expiresAt,
        };

        for (const id of others) emitTo(id, "call:incoming", incoming);
        // The caller's own devices, so a ring started on the phone shows as
        // ringing on the laptop rather than as nothing at all.
        emitTo(self, "call:ringing", incoming);

        consola.info(`[Call] ${self} is ringing ${others.length} in ${payload.conversationId}`);
      } catch (error) {
        consola.error(`[Call] ring failed:`, error);
        socket.emit("call:error", { error: "failed", message: "Could not start the call" });
      }
    },

    /**
     * Say no.
     *
     * Ends the ring for everybody rather than for the person declining. In a
     * one-to-one there is nobody else, and in a group the alternative is a ring
     * that keeps going at the people who have not answered while the caller has
     * already been told no — which reads, on the caller's screen, as somebody
     * declining and the call carrying on anyway.
     */
    'call:decline': async (payload: { accessToken: string; conversationId: string }) => {
      try {
        if (!payload || typeof payload.accessToken !== "string" || typeof payload.conversationId !== "string") {
          socket.emit("call:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const rl = checkRateLimit("call:decline", clientsInfo[clientId]?.serverUserId, getClientIp(), RL_ANSWER);
        if (!rl.allowed) {
          socket.emit("call:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const self = auth.tokenPayload.serverUserId;
        const ring = getRing(payload.conversationId);
        // Silently fine. A ring that timed out a moment before the tap landed
        // is the ordinary case, not an error worth a message.
        if (!ring || !ring.toServerUserIds.includes(self)) return;

        endRing(payload.conversationId);
        withdraw(ring, "declined", self);
      } catch (error) {
        consola.error(`[Call] decline failed:`, error);
      }
    },

    /**
     * Give up before anybody answers.
     *
     * Only the person who started it. Anybody else in the conversation saying
     * "stop ringing" is a decline, which says something different to the
     * caller.
     */
    'call:cancel': async (payload: { accessToken: string; conversationId: string }) => {
      try {
        if (!payload || typeof payload.accessToken !== "string" || typeof payload.conversationId !== "string") {
          socket.emit("call:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const rl = checkRateLimit("call:cancel", clientsInfo[clientId]?.serverUserId, getClientIp(), RL_ANSWER);
        if (!rl.allowed) return;

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const self = auth.tokenPayload.serverUserId;
        const ring = getRing(payload.conversationId);
        if (!ring || ring.fromServerUserId !== self) return;

        endRing(payload.conversationId);
        withdraw(ring, "cancelled", self);
      } catch (error) {
        consola.error(`[Call] cancel failed:`, error);
      }
    },
  };
}

/**
 * Stop the rings a person started, because they are no longer there.
 *
 * Called when somebody joins the call they were ringing about — answering ends
 * the ring, including on their own other devices — and when a caller's last
 * socket goes away.
 *
 * Exported as a plain function rather than an event because both callers are
 * elsewhere: the join is in the voice handler and the disconnect is in
 * `socket/index.ts`. Ringing state is this file's, so ending it is too.
 */
export function endRingsFor(
  io: HandlerContext["io"],
  clientsInfo: HandlerContext["clientsInfo"],
  options: { conversationId: string; answeredBy: string } | { callerGone: string },
): void {
  const emitTo = (serverUserId: string, event: string, payload: unknown) => {
    for (const [cid, ci] of Object.entries(clientsInfo)) {
      if (ci.serverUserId !== serverUserId) continue;
      io.sockets.sockets.get(cid)?.emit(event, payload);
    }
  };

  const tell = (ring: CallRing, reason: RingEnd, endedBy: string | null) => {
    const payload = { conversation_id: ring.conversationId, reason, ended_by: endedBy };
    for (const id of ring.toServerUserIds) emitTo(id, "call:withdrawn", payload);
    emitTo(ring.fromServerUserId, "call:withdrawn", payload);
  };

  if ("conversationId" in options) {
    const ring = endRing(options.conversationId);
    if (ring) tell(ring, "answered", options.answeredBy);
    return;
  }

  // A caller who has gone. Only their rings — the people they were ringing can
  // decline, which is a different thing to say, and nobody else can end a ring
  // they did not start.
  for (const ring of ringsFrom(options.callerGone)) {
    const ended = endRing(ring.conversationId);
    if (ended) tell(ended, "cancelled", null);
  }
}
