import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import {
  blockUser,
  unblockUser,
  listBlocks,
  getUserByServerId,
} from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";

/**
 * No permission is checked: blocking has to work against somebody who outranks
 * you. Nothing ever reaches the blocked person, not even a refusal that says so.
 */

/* Looser than reporting: nobody has to review a block, and somebody may make
   several in a row. Still bounded, because each call writes. */
const RL_BLOCK: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 20, scoreDecayMs: 3_000 };

export function registerBlockHandlers(ctx: HandlerContext): EventHandlerMap {
  const { socket, clientId, clientsInfo } = ctx;

  function rlCheck(event: string) {
    const ip = ctx.getClientIp();
    const userId = clientsInfo[clientId]?.serverUserId;
    return checkRateLimit(event, userId, ip, RL_BLOCK);
  }

  return {
    "user:block": async (payload: { accessToken: string; serverUserId: string }) => {
      try {
        const rl = rlCheck("user:block");
        if (!rl.allowed) {
          socket.emit("server:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
          });
          return;
        }

        if (!payload?.serverUserId) {
          socket.emit("server:error", { error: "invalid_payload" });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        /* Blocking yourself would stop your own messages reaching you, which
         * is a state with no way back through the UI that made it. */
        if (payload.serverUserId === auth.tokenPayload.serverUserId) {
          socket.emit("server:error", { error: "cannot_block_self" });
          return;
        }

        const target = await getUserByServerId(payload.serverUserId);
        if (!target) {
          socket.emit("server:error", { error: "user_not_found" });
          return;
        }

        await blockUser(auth.tokenPayload.grytUserId, target.gryt_user_id);

        /* The conversation used to be hidden here too. Hiding is the client's
           own, per device, since GRYT-1379, so it does that on `user:blocked`. */
        socket.emit("user:blocked", { serverUserId: payload.serverUserId });
      } catch (err) {
        consola.error("user:block failed", err);
        socket.emit("server:error", { error: "block_failed" });
      }
    },

    "user:unblock": async (payload: { accessToken: string; serverUserId: string }) => {
      try {
        const rl = rlCheck("user:unblock");
        if (!rl.allowed) {
          socket.emit("server:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs });
          return;
        }

        if (!payload?.serverUserId) {
          socket.emit("server:error", { error: "invalid_payload" });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        /* Looked up rather than required: somebody blocked and then banned is
           gone from `users`, and the row still has to be removable. */
        const target = await getUserByServerId(payload.serverUserId);
        if (target) {
          await unblockUser(auth.tokenPayload.grytUserId, target.gryt_user_id);
        }

        socket.emit("user:unblocked", { serverUserId: payload.serverUserId });
      } catch (err) {
        consola.error("user:unblock failed", err);
        socket.emit("server:error", { error: "unblock_failed" });
      }
    },

    "user:blocks:list": async (payload: { accessToken: string }) => {
      try {
        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        socket.emit("user:blocks", {
          blocked: await listBlocks(auth.tokenPayload.grytUserId),
        });
      } catch (err) {
        consola.error("user:blocks:list failed", err);
        socket.emit("server:error", { error: "blocks_list_failed" });
      }
    },
  };
}
