import consola from "consola";

import {
  getConversation,
  getServerConfig,
  getUserByServerId,
  getUsersByServerIds,
  isConversationMember,
  listConversationsForUser,
  openDirectConversation,
  setConversationHidden,
} from "../../db";
import { isBotIdentity } from "../../auth/identity";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { requireAuth } from "../middleware/auth";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Opening and listing direct messages.
 *
 * Sending, editing, reacting and fetching history are not here — a DM is a
 * conversation like any other once it exists, so it goes through the same
 * `chat:*` events, and `socket/utils/conversationAccess.ts` is what decides
 * whether the caller is party to it. This file is only the two things that are
 * specific to DMs: making one, and listing the ones you are in.
 *
 * These conversations are local to this server and are not related to a DM the
 * same two people may have on another one. See `db/sqlite/conversations.ts`.
 */

const RL_OPEN: RateLimitRule = { limit: 10, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 3000 };
const RL_LIST: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 0.3, maxScore: 8, scoreDecayMs: 2000 };

export interface DirectConversationView {
  conversation_id: string;
  created_at: string;
  last_message_at: string | null;
  other: {
    server_user_id: string;
    nickname: string;
    avatar_file_id: string | null;
    avatar_worn: string | null;
  };
}

/**
 * One member's direct messages, as the client sees them.
 *
 * Outside the handler closure because the chat path needs it as well: a
 * message arriving in a conversation somebody had hidden brings it back, and
 * the row it comes back as is this one.
 */
export async function directConversationViews(serverUserId: string): Promise<DirectConversationView[]> {
  const conversations = await listConversationsForUser(serverUserId);
  const otherIds = [...new Set(conversations.flatMap((c) => c.other_server_user_ids))];
  const users = otherIds.length > 0 ? await getUsersByServerIds(otherIds) : new Map();

  return conversations.flatMap((c) => {
    const otherId = c.other_server_user_ids[0];
    if (!otherId) return [];
    const other = users.get(otherId);
    return [{
      conversation_id: c.conversation_id,
      created_at: c.created_at.toISOString(),
      last_message_at: c.last_message_at ? c.last_message_at.toISOString() : null,
      other: {
        server_user_id: otherId,
        nickname: other?.nickname ?? "Unknown",
        avatar_file_id: other?.avatar_file_id ?? null,
        avatar_worn: other?.avatar_worn ?? null,
      },
    }];
  });
}

export function registerDirectMessageHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, clientsInfo, getClientIp } = ctx;

  /**
   * Everybody currently connected as this member.
   *
   * A person can have the desktop app and a phone open at once, and both should
   * see a conversation appear.
   */
  function socketIdsFor(serverUserId: string): string[] {
    return Object.entries(clientsInfo)
      .filter(([, ci]) => ci.serverUserId === serverUserId)
      .map(([cid]) => cid);
  }

  const viewsFor = directConversationViews;

  return {
    /**
     * Open the direct message with another member, or return the existing one.
     *
     * The caller names the person they want to talk to and nothing else. Their
     * own side of the conversation is taken from the verified token, never from
     * the payload — a client that could name both ends could open a
     * conversation between two other people and then be a member of it.
     */
    'dm:open': async (payload: { accessToken: string; targetServerUserId: string }) => {
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("dm:open", clientsInfo[clientId]?.serverUserId, ip, RL_OPEN);
        if (!rl.allowed) {
          socket.emit("dm:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || typeof payload.accessToken !== "string" || typeof payload.targetServerUserId !== "string") {
          socket.emit("dm:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "send_direct_messages" });
        if (!auth) return;

        const cfg = await getServerConfig().catch(() => null);
        if (cfg && cfg.allow_dms === false) {
          socket.emit("dm:error", { error: "dms_disabled", message: "Direct messages are turned off on this server" });
          return;
        }

        const self = auth.tokenPayload.serverUserId;
        const target = payload.targetServerUserId;

        if (target === self) {
          socket.emit("dm:error", { error: "invalid_target", message: "You cannot open a conversation with yourself" });
          return;
        }

        // A member of this server, and still one. Without this the id is
        // whatever the client typed, and a conversation could be filed against
        // somebody who was never here — which nobody could read, but which
        // would sit in the table and in the other person's list forever.
        const targetUser = await getUserByServerId(target);
        if (!targetUser || !targetUser.is_active) {
          socket.emit("dm:error", { error: "unknown_member", message: "That person is not a member of this server" });
          return;
        }

        if (isBotIdentity(targetUser.gryt_user_id)) {
          socket.emit("dm:error", { error: "invalid_target", message: "You cannot message a bot" });
          return;
        }

        const conversation = await openDirectConversation(self, target);

        // Asking for a conversation you had hidden is asking for it back. Only
        // the caller's row: the other party hiding it is their answer, and it
        // is the message that follows which brings theirs back, not this.
        await setConversationHidden(conversation.conversation_id, self, false);

        // Both ends are told, and each is told about the other rather than
        // about themselves, so neither has to work out which member of the
        // conversation it is looking at.
        for (const serverUserId of [self, target]) {
          const views = await viewsFor(serverUserId);
          const view = views.find((v) => v.conversation_id === conversation.conversation_id);
          if (!view) continue;
          for (const cid of socketIdsFor(serverUserId)) {
            io.sockets.sockets.get(cid)?.emit("dm:opened", view);
          }
        }
      } catch (err) {
        consola.error("dm:open failed", err);
        socket.emit("dm:error", { error: "failed", message: "Could not open the conversation" });
      }
    },

    /**
     * Take a conversation out of your own sidebar, or put it back.
     *
     * Nothing is deleted and nobody else is affected — `hidden_at` is on the
     * caller's own membership row. A message arriving in the conversation
     * brings it back on its own, which is why this is not a way to stop
     * somebody talking to you.
     */
    'dm:setHidden': async (payload: { accessToken: string; conversationId: string; hidden: boolean }) => {
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("dm:setHidden", clientsInfo[clientId]?.serverUserId, ip, RL_OPEN);
        if (!rl.allowed) {
          socket.emit("dm:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || typeof payload.accessToken !== "string" || typeof payload.conversationId !== "string" || typeof payload.hidden !== "boolean") {
          socket.emit("dm:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const self = auth.tokenPayload.serverUserId;

        // A conversation, and one of theirs. Without the membership check this
        // would write a row for somebody else's conversation — harmless today,
        // since the row would not exist, but it is the check that keeps it
        // harmless if the table ever gains a different key.
        const conversation = await getConversation(payload.conversationId);
        if (!conversation || !(await isConversationMember(payload.conversationId, self))) {
          socket.emit("dm:error", { error: "not_found", message: "No such conversation" });
          return;
        }

        await setConversationHidden(payload.conversationId, self, payload.hidden);

        // Every socket this person has, so hiding on the desktop takes it off
        // the phone as well.
        for (const cid of socketIdsFor(self)) {
          io.sockets.sockets.get(cid)?.emit("dm:hidden", {
            conversation_id: payload.conversationId,
            hidden: payload.hidden,
          });
        }
      } catch (err) {
        consola.error("dm:setHidden failed", err);
        socket.emit("dm:error", { error: "failed", message: "Could not update the conversation" });
      }
    },

    /** Every direct message this member is party to, most recent first. */
    'dm:list': async (payload: { accessToken: string }) => {
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("dm:list", clientsInfo[clientId]?.serverUserId, ip, RL_LIST);
        if (!rl.allowed) {
          socket.emit("dm:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || typeof payload.accessToken !== "string") {
          socket.emit("dm:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        socket.emit("dm:list", { items: await viewsFor(auth.tokenPayload.serverUserId) });
      } catch (err) {
        consola.error("dm:list failed", err);
        socket.emit("dm:error", { error: "failed", message: "Could not list conversations" });
      }
    },
  };
}
