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
 * The call itself is not here — it is an SFU room whose id is the conversation
 * id, joined through the ordinary `voice:room:request`. So there is no
 * `call:accept`: answering is joining, and the join stops the ring rather than
 * a separate message that could disagree with it.
 *
 * Every ring goes to **all** of a person's sockets and every ending is
 * withdrawn from all of them, or answering on the laptop leaves the phone
 * ringing in a pocket.
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
   * Tell everybody the ring reached that it stopped, and why. The caller too —
   * they are not being rung, and would otherwise sit on "ringing…".
   */
  function withdraw(ring: CallRing, reason: RingEnd, endedBy?: string): void {
    const payload = { conversation_id: ring.conversationId, reason, ended_by: endedBy ?? null };
    for (const id of ring.toServerUserIds) emitTo(id, "call:withdrawn", payload);
    emitTo(ring.fromServerUserId, "call:withdrawn", payload);
  }

  return {
    /**
     * Ring everybody else in a conversation. Three permissions, because this is
     * three things at once: `send_direct_messages`, so the call button is not a
     * way back into DMs a role lost; `join_voice`, or the call can only be
     * answered into an empty room; and `start_calls` (GRYT-712), which says who
     * may place one without saying anything about who may take one.
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
     * Say no. Ends the ring for everybody: otherwise a group keeps ringing at
     * the people who have not answered while the caller has been told no.
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
     * Give up before anybody answers. Only the person who started it —
     * anybody else saying "stop ringing" is a decline.
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
 * Stop the rings a person started. Called when they join the call they were
 * ringing about, and when their last socket goes away. A plain function
 * because both callers live elsewhere.
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
