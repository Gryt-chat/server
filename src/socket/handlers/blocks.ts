import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import {
  blockUser,
  unblockUser,
  listBlocks,
  getUserByServerId,
  hideConversationsBetween,
} from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";

/**
 * Blocking somebody, which is a personal act rather than a moderator one.
 *
 * No permission is checked anywhere in here. That is the point: blocking has
 * to work against somebody who outranks you, or it does not work for the
 * person who needs it most.
 *
 * **Nothing is ever sent to the blocked person.** No event, no member-list
 * marker, no error that names the reason. A block that announces itself
 * invites the retaliation it exists to stop. They can infer it when a
 * conversation will not open, which is true of every product that has this,
 * and the refusal they get is the ordinary one.
 */

/* Looser than reporting. Blocking is not an accusation anybody has to review,
 * and somebody clearing out a bad afternoon may block several people in a row.
 * Still bounded, because each call writes. */
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

        /* The conversation goes out of the blocker's list, and only theirs.
         * `hidden_at` is per member and already exists for the ordinary
         * "close this conversation" case, so this is the same act somebody
         * could have done by hand. */
        await hideConversationsBetween(
          auth.tokenPayload.serverUserId,
          payload.serverUserId,
        );

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

        /* Looked up rather than required to exist. Somebody blocked and then
         * banned is gone from `users`, and their block row has to be
         * removable or the list has an entry nobody can clear. */
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
