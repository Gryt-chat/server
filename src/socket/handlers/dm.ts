import consola from "consola";

import {
  addConversationMember,
  createGroupConversation,
  getConversation,
  getServerConfig,
  getUserByServerId,
  getUsersByServerIds,
  isConversationMember,
  leaveConversation,
  listConversationMemberIds,
  listConversationsForUser,
  MAX_CONVERSATION_MEMBERS,
  purgeOrphanedConversations,
  openDirectConversation,
  setConversationHidden,
  setConversationIcon,
  setConversationName,
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

export interface ConversationParticipant {
  server_user_id: string;
  nickname: string;
  avatar_file_id: string | null;
  avatar_worn: string | null;
}

export interface DirectConversationView {
  conversation_id: string;
  kind: "dm" | "group";
  /** What a group was named, or null to read it off `members`. Null on a `dm`. */
  name: string | null;
  /**
   * A picture somebody uploaded for the group.
   *
   * Null means draw one from the name rather than "no picture" — a group with
   * no upload gets the same treatment a server with no icon does, which is why
   * nothing is stored for it.
   */
  icon_file_id: string | null;
  created_at: string;
  last_message_at: string | null;
  /** Everybody but you, in the order the server holds them. */
  members: ConversationParticipant[];
  /**
   * The first of `members`.
   *
   * Redundant, and kept on purpose: it is what a client written before groups
   * existed reads, and dropping it would turn every one of those into a crash
   * on `other.nickname` rather than a client that simply does not know what a
   * group is. On a group it names one arbitrary person, which reads oddly on
   * an old build and does not break it.
   */
  other: ConversationParticipant;
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

  const participant = (id: string): ConversationParticipant => {
    const user = users.get(id);
    return {
      server_user_id: id,
      nickname: user?.nickname ?? "Unknown",
      avatar_file_id: user?.avatar_file_id ?? null,
      avatar_worn: user?.avatar_worn ?? null,
    };
  };

  return conversations.flatMap((c) => {
    const members = c.other_server_user_ids.map(participant);
    // A conversation with nobody else in it is one everybody else has left.
    // There is nothing to draw and no name to give it, so it is left out
    // rather than listed as a row naming "Unknown".
    if (members.length === 0) return [];
    return [{
      conversation_id: c.conversation_id,
      kind: c.kind,
      name: c.name,
      icon_file_id: c.icon_file_id,
      created_at: c.created_at.toISOString(),
      last_message_at: c.last_message_at ? c.last_message_at.toISOString() : null,
      members,
      other: members[0],
    }];
  });
}

/** Tell everybody in a conversation what it looks like to each of them. */
async function broadcastConversation(
  io: HandlerContext["io"],
  clientsInfo: HandlerContext["clientsInfo"],
  conversationId: string,
  memberIds: string[],
): Promise<void> {
  for (const serverUserId of memberIds) {
    const views = await directConversationViews(serverUserId);
    const view = views.find((v) => v.conversation_id === conversationId);
    if (!view) continue;
    for (const [cid, ci] of Object.entries(clientsInfo)) {
      if (ci.serverUserId !== serverUserId) continue;
      io.sockets.sockets.get(cid)?.emit("dm:opened", view);
    }
  }
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

    /**
     * Start a group conversation.
     *
     * Adding somebody to a one-to-one does not happen. This makes a new
     * conversation with a new id, and the pair conversation stays exactly as
     * it was — the history two people built is not something a third should
     * inherit because somebody tapped "add". Discord draws the same line.
     */
    'dm:group:create': async (payload: { accessToken: string; memberIds: string[]; name?: string; iconFileId?: string }) => {
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("dm:group:create", clientsInfo[clientId]?.serverUserId, ip, RL_OPEN);
        if (!rl.allowed) {
          socket.emit("dm:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || typeof payload.accessToken !== "string" || !Array.isArray(payload.memberIds)) {
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
        const targets = [...new Set(payload.memberIds.filter((id) => typeof id === "string" && id !== self))];

        if (targets.length < 2) {
          socket.emit("dm:error", { error: "too_few", message: "A group needs at least two other people" });
          return;
        }
        if (targets.length + 1 > MAX_CONVERSATION_MEMBERS) {
          socket.emit("dm:error", { error: "too_many", message: `A group can hold ${MAX_CONVERSATION_MEMBERS} people` });
          return;
        }

        // Every one of them, checked before anything is written. A group made
        // with one bad id would otherwise exist with a member nobody can see.
        for (const id of targets) {
          const user = await getUserByServerId(id);
          if (!user || !user.is_active) {
            socket.emit("dm:error", { error: "unknown_member", message: "Somebody in that list is not a member of this server" });
            return;
          }
          if (isBotIdentity(user.gryt_user_id)) {
            socket.emit("dm:error", { error: "invalid_target", message: "You cannot add a bot to a group" });
            return;
          }
        }

        const conversation = await createGroupConversation(self, targets);
        if (typeof payload.name === "string" && payload.name.trim()) {
          await setConversationName(conversation.conversation_id, payload.name);
        }
        // Taken here rather than left to a follow-up `dm:group:update`. The
        // client uploads the picture before the group exists, so without this
        // it would have to wait for `dm:opened` to learn the id and then send
        // a second event — and a group would exist, briefly, wearing the drawn
        // icon it was not meant to have.
        if (typeof payload.iconFileId === "string" && payload.iconFileId) {
          await setConversationIcon(conversation.conversation_id, payload.iconFileId);
        }

        await broadcastConversation(io, clientsInfo, conversation.conversation_id, [self, ...targets]);
      } catch (err) {
        consola.error("dm:group:create failed", err);
        socket.emit("dm:error", { error: "failed", message: "Could not start the group" });
      }
    },

    /** Add somebody to a group you are in. Anybody in it may; there is no owner. */
    'dm:group:add': async (payload: { accessToken: string; conversationId: string; targetServerUserId: string }) => {
      try {
        if (!payload || typeof payload.accessToken !== "string" || typeof payload.conversationId !== "string" || typeof payload.targetServerUserId !== "string") {
          socket.emit("dm:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "send_direct_messages" });
        if (!auth) return;

        const self = auth.tokenPayload.serverUserId;
        const conversation = await getConversation(payload.conversationId);
        if (!conversation || !(await isConversationMember(payload.conversationId, self))) {
          socket.emit("dm:error", { error: "not_found", message: "No such conversation" });
          return;
        }
        if (conversation.kind !== "group") {
          socket.emit("dm:error", { error: "not_a_group", message: "Start a group to add more people" });
          return;
        }

        const target = await getUserByServerId(payload.targetServerUserId);
        if (!target || !target.is_active || isBotIdentity(target.gryt_user_id)) {
          socket.emit("dm:error", { error: "unknown_member", message: "That person is not a member of this server" });
          return;
        }

        await addConversationMember(payload.conversationId, payload.targetServerUserId);
        await broadcastConversation(
          io,
          clientsInfo,
          payload.conversationId,
          await listConversationMemberIds(payload.conversationId),
        );
      } catch (err) {
        consola.error("dm:group:add failed", err);
        socket.emit("dm:error", { error: "failed", message: err instanceof Error && err.message.includes("at most") ? `A group can hold ${MAX_CONVERSATION_MEMBERS} people` : "Could not add them" });
      }
    },

    /**
     * Leave a group for good.
     *
     * Not hiding. Hiding is your own sidebar and a message brings it back;
     * this drops the membership, so nothing arrives afterwards and the history
     * stops being yours to read.
     */
    'dm:group:leave': async (payload: { accessToken: string; conversationId: string }) => {
      try {
        if (!payload || typeof payload.accessToken !== "string" || typeof payload.conversationId !== "string") {
          socket.emit("dm:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const self = auth.tokenPayload.serverUserId;
        const conversation = await getConversation(payload.conversationId);
        if (!conversation || !(await isConversationMember(payload.conversationId, self))) {
          socket.emit("dm:error", { error: "not_found", message: "No such conversation" });
          return;
        }
        if (conversation.kind !== "group") {
          socket.emit("dm:error", { error: "not_a_group", message: "Hide a direct message instead of leaving it" });
          return;
        }

        await leaveConversation(payload.conversationId, self);

        // The last person out takes the room with them. Without this a group
        // everybody left would sit in the table for good, holding messages
        // nobody can reach — the same sweep `server:leave` already does, run
        // at the other moment a conversation can empty out.
        const remaining = await listConversationMemberIds(payload.conversationId);
        if (remaining.length === 0) {
          await purgeOrphanedConversations().catch((e) =>
            consola.warn("purging the empty group failed", e),
          );
        }

        for (const cid of socketIdsFor(self)) {
          io.sockets.sockets.get(cid)?.emit("dm:left", { conversation_id: payload.conversationId });
        }
        await broadcastConversation(io, clientsInfo, payload.conversationId, remaining);
      } catch (err) {
        consola.error("dm:group:leave failed", err);
        socket.emit("dm:error", { error: "failed", message: "Could not leave the group" });
      }
    },

    /**
     * Change what a group is called and what it looks like.
     *
     * One event rather than two, because the screen that changes either
     * changes both, and a client that sent them separately would draw a group
     * renamed but not re-pictured for one round trip.
     *
     * Both are `null`-able and both mean "go back to the drawn one": a group
     * with no name reads off its members, and a group with no upload is drawn
     * from that name.
     */
    'dm:group:update': async (payload: { accessToken: string; conversationId: string; name?: string | null; iconFileId?: string | null }) => {
      try {
        if (!payload || typeof payload.accessToken !== "string" || typeof payload.conversationId !== "string") {
          socket.emit("dm:error", { error: "invalid_payload", message: "Invalid payload" });
          return;
        }

        const auth = await requireAuth(socket, payload, { permission: "send_direct_messages" });
        if (!auth) return;

        const self = auth.tokenPayload.serverUserId;
        const conversation = await getConversation(payload.conversationId);
        if (!conversation || conversation.kind !== "group" || !(await isConversationMember(payload.conversationId, self))) {
          socket.emit("dm:error", { error: "not_found", message: "No such conversation" });
          return;
        }

        if ("name" in payload) {
          await setConversationName(payload.conversationId, typeof payload.name === "string" ? payload.name : null);
        }
        if ("iconFileId" in payload) {
          await setConversationIcon(
            payload.conversationId,
            typeof payload.iconFileId === "string" && payload.iconFileId ? payload.iconFileId : null,
          );
        }
        await broadcastConversation(
          io,
          clientsInfo,
          payload.conversationId,
          await listConversationMemberIds(payload.conversationId),
        );
      } catch (err) {
        consola.error("dm:group:update failed", err);
        socket.emit("dm:error", { error: "failed", message: "Could not update the group" });
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
