import consola from "consola";
import { randomUUID } from "crypto";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import {
  insertMessage,
  listMessages,
  MessageRecord,
  getUserByServerId,
  getUsersByServerIds,
  verifyUserIdentity,
  addReactionToMessage,
  deleteMessage,
  getMessageById,
  updateMessageText,
  getFilesByIds,
  getServerConfig,
  DEFAULT_UPLOAD_MAX_BYTES,
} from "../../db/scylla";
import { verifyAccessToken } from "../../utils/jwt";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";

const RL_SEND: RateLimitRule = { limit: 20, windowMs: 10_000, banMs: 30_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 2000 };
const RL_REACT: RateLimitRule = { limit: 60, windowMs: 60_000, scorePerAction: 0.5, maxScore: 15, scoreDecayMs: 3000 };
const RL_DELETE: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 15, scoreDecayMs: 3000 };
const RL_EDIT: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 2000 };
const RL_FETCH: RateLimitRule = { limit: 15, windowMs: 10_000, scorePerAction: 0.3, maxScore: 8, scoreDecayMs: 1500 };

const MESSAGE_CACHE_TTL_MS = parseInt(process.env.MESSAGE_CACHE_TTL_MS || "30000");
const messageCache = new Map<string, { items: MessageRecord[]; fetchedAt: number }>();

const NONCE_TTL_MS = 60_000;
const recentNonces = new Map<string, { message: MessageRecord; createdAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of messageCache) {
    if (now - entry.fetchedAt > MESSAGE_CACHE_TTL_MS * 2) messageCache.delete(key);
  }
  for (const [nonce, entry] of recentNonces) {
    if (now - entry.createdAt > NONCE_TTL_MS) recentNonces.delete(nonce);
  }
}, 60_000);

async function getMessagesCached(conversationId: string, limit = 50): Promise<MessageRecord[]> {
  const now = Date.now();
  const cached = messageCache.get(conversationId);
  if (cached && now - cached.fetchedAt < MESSAGE_CACHE_TTL_MS) return cached.items.slice(0, limit);
  const items = await listMessages(conversationId, limit);
  messageCache.set(conversationId, { items, fetchedAt: now });
  return items;
}

function isConversationAVoiceChannel(conversationId: string, sfuClient: any): boolean {
  if (!sfuClient?.isConnected()) return false;
  const activeUsers = sfuClient.getActiveUsers();
  for (const [, conn] of activeUsers) {
    if (conn.roomId === conversationId) return true;
  }
  return false;
}

function isUserConnectedToSpecificVoiceChannel(serverUserId: string, conversationId: string, sfuClient: any): boolean {
  if (!sfuClient?.isConnected()) return false;
  const userConnection = sfuClient.getActiveUsers().get(serverUserId);
  return userConnection?.roomId === conversationId;
}

async function enrichMessages(messages: MessageRecord[]): Promise<MessageRecord[]> {
  const senderIds = [...new Set(messages.map(m => m.sender_server_id).filter(Boolean))];
  if (senderIds.length === 0) return messages;
  const userMap = await getUsersByServerIds(senderIds);
  return messages.map(m => {
    const info = userMap.get(m.sender_server_id);
    return {
      ...m,
      sender_nickname: info?.nickname ?? "Unknown",
      sender_avatar_file_id: info?.avatar_file_id,
    };
  });
}

async function enrichAttachments(messages: MessageRecord[]): Promise<MessageRecord[]> {
  const allFileIds = new Set<string>();
  for (const m of messages) {
    if (m.attachments) m.attachments.forEach(id => allFileIds.add(id));
  }
  if (allFileIds.size === 0) return messages;
  const fileMap = await getFilesByIds([...allFileIds]);
  return messages.map(m => {
    if (!m.attachments || m.attachments.length === 0) return m;
    const enriched = m.attachments.map(id => {
      const f = fileMap.get(id);
      if (!f) return { file_id: id, mime: null, size: null, original_name: null, width: null, height: null, has_thumbnail: false };
      return {
        file_id: f.file_id,
        mime: f.mime,
        size: f.size,
        original_name: f.original_name,
        width: f.width,
        height: f.height,
        has_thumbnail: !!f.thumbnail_key,
      };
    });
    return { ...m, enriched_attachments: enriched };
  });
}

export function registerChatHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, clientsInfo, sfuClient, getClientIp } = ctx;

  return {
    'chat:send': async (payload: { conversationId: string; accessToken: string; text?: string; attachments?: string[]; replyToMessageId?: string; nonce?: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:send", userId, ip, RL_SEND);
        if (!rl.allowed) {
          socket.emit("chat:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || typeof payload.conversationId !== "string" || typeof payload.accessToken !== "string") {
          socket.emit("chat:error", "Invalid payload");
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        // Identity verification
        if (userId && payload.accessToken) {
          const identityValid = await verifyUserIdentity(auth.tokenPayload.serverUserId, auth.tokenPayload.grytUserId);
          if (!identityValid) { socket.emit("chat:error", "Identity verification failed"); return; }
        }

        // Voice channel gate
        if (userId && isConversationAVoiceChannel(payload.conversationId, sfuClient)) {
          if (!isUserConnectedToSpecificVoiceChannel(userId, payload.conversationId, sfuClient)) {
            socket.emit("chat:error", "You must be connected to this voice channel to send messages");
            return;
          }
        }

        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : null;
        if (!text && (!attachments || attachments.length === 0)) {
          socket.emit("chat:error", "Message is empty");
          return;
        }

        if (attachments && attachments.length > 0) {
          const fileMap = await getFilesByIds(attachments);
          const cfg = await getServerConfig().catch(() => null);
          const maxBytes = typeof cfg?.upload_max_bytes === "number" ? cfg.upload_max_bytes : DEFAULT_UPLOAD_MAX_BYTES;
          for (const id of attachments) {
            const f = fileMap.get(id);
            if (!f) {
              socket.emit("chat:error", `Attachment not found: ${id}`);
              return;
            }
            if (typeof maxBytes === "number" && maxBytes > 0 && f.size != null && f.size > maxBytes) {
              const limitMb = (maxBytes / (1024 * 1024)).toFixed(1);
              socket.emit("chat:error", `File "${f.original_name || id}" is too large. Max ${limitMb}MB.`);
              return;
            }
          }
        }

        const user = await getUserByServerId(auth.tokenPayload.serverUserId);
        if (!user) { socket.emit("chat:error", "User not found. Please rejoin."); return; }

        const replyToMessageId = typeof payload.replyToMessageId === "string" ? payload.replyToMessageId : null;

        if (payload.nonce && recentNonces.has(payload.nonce)) {
          const cached = recentNonces.get(payload.nonce)!;
          const connectedClients = Object.entries(clientsInfo).filter(([, ci]) => {
            if (isConversationAVoiceChannel(cached.message.conversation_id, sfuClient)) {
              return isUserConnectedToSpecificVoiceChannel(ci.serverUserId, cached.message.conversation_id, sfuClient);
            }
            return true;
          });
          connectedClients.forEach(([cid]) => {
            io.sockets.sockets.get(cid)?.emit("chat:new", cached.message);
          });
          return;
        }

        const created = await insertMessage({
          conversation_id: payload.conversationId,
          sender_server_id: auth.tokenPayload.serverUserId,
          text: text || null,
          attachments: attachments && attachments.length > 0 ? attachments : null,
          reactions: null,
          reply_to_message_id: replyToMessageId,
        });

        let enriched: MessageRecord = {
          ...created,
          sender_nickname: user.nickname,
          sender_avatar_file_id: user.avatar_file_id,
        };
        const [withAttachments] = await enrichAttachments([enriched]);
        enriched = withAttachments;

        if (payload.nonce) {
          recentNonces.set(payload.nonce, { message: enriched, createdAt: Date.now() });
        }

        const existing = messageCache.get(created.conversation_id);
        const items = existing?.items ? [...existing.items, created] : [created];
        messageCache.set(created.conversation_id, { items, fetchedAt: Date.now() });

        // Targeted broadcast (voice channels only to connected users)
        const connectedClients = Object.entries(clientsInfo).filter(([, ci]) => {
          if (isConversationAVoiceChannel(created.conversation_id, sfuClient)) {
            return isUserConnectedToSpecificVoiceChannel(ci.serverUserId, created.conversation_id, sfuClient);
          }
          return true;
        });

        connectedClients.forEach(([cid]) => {
          io.sockets.sockets.get(cid)?.emit("chat:new", enriched);
        });
      } catch (err) {
        consola.error("chat:send failed", err);
        try {
          const now = new Date();
          const fallback = {
            conversation_id: payload?.conversationId || "unknown",
            sender_server_id: "unknown",
            text: payload?.text || null,
            attachments: payload?.attachments?.length ? payload.attachments : null,
            message_id: randomUUID(),
            created_at: now,
            reactions: null,
            ephemeral: true,
          } as any;
          const connectedClients = Object.entries(clientsInfo).filter(([, ci]) => {
            if (isConversationAVoiceChannel(fallback.conversation_id, sfuClient)) {
              return isUserConnectedToSpecificVoiceChannel(ci.serverUserId, fallback.conversation_id, sfuClient);
            }
            return true;
          });
          connectedClients.forEach(([cid]) => {
            io.sockets.sockets.get(cid)?.emit("chat:new", fallback);
          });
          socket.emit("chat:error", "Message not persisted (temporary storage issue)");
        } catch { socket.emit("chat:error", "Failed to send message"); }
      }
    },

    'chat:fetch': async (payload: { conversationId: string; limit?: number }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:fetch", userId, ip, RL_FETCH);
        if (!rl.allowed) {
          socket.emit("chat:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string") { socket.emit("chat:error", "Invalid fetch payload"); return; }

        if (userId && isConversationAVoiceChannel(payload.conversationId, sfuClient)) {
          if (!isUserConnectedToSpecificVoiceChannel(userId, payload.conversationId, sfuClient)) {
            socket.emit("chat:error", "You must be connected to this voice channel");
            return;
          }
        }

        const limit = typeof payload.limit === "number" ? payload.limit : 50;
        const items = await getMessagesCached(payload.conversationId, limit);
        let enrichedItems = await enrichMessages(items);
        enrichedItems = await enrichAttachments(enrichedItems);
        socket.emit("chat:history", { conversation_id: payload.conversationId, items: enrichedItems });
      } catch (err) {
        consola.error("chat:fetch failed", err);
        socket.emit("chat:error", "Failed to fetch messages");
      }
    },

    'chat:react': async (payload: { conversationId: string; messageId: string; reactionSrc: string; accessToken: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:react", userId, ip, RL_REACT);
        if (!rl.allowed) {
          socket.emit("chat:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || !payload.conversationId || !payload.messageId || !payload.reactionSrc || !payload.accessToken) {
          socket.emit("chat:error", "Invalid reaction payload");
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const user = await getUserByServerId(auth.tokenPayload.serverUserId);
        if (!user) { socket.emit("chat:error", "User not found"); return; }

        const updatedMessage = await addReactionToMessage(payload.conversationId, payload.messageId, payload.reactionSrc, auth.tokenPayload.serverUserId);
        if (!updatedMessage) { socket.emit("chat:error", "Message not found"); return; }

        const existing = messageCache.get(updatedMessage.conversation_id);
        if (existing?.items) {
          messageCache.set(updatedMessage.conversation_id, {
            items: existing.items.map((m) => m.message_id === updatedMessage.message_id ? updatedMessage : m),
            fetchedAt: existing.fetchedAt,
          });
        }

        let [enrichedReaction] = await enrichMessages([updatedMessage]);
        [enrichedReaction] = await enrichAttachments([enrichedReaction]);
        io.emit("chat:reaction", enrichedReaction);
      } catch (err) {
        consola.error("chat:react failed", err);
        socket.emit("chat:error", "Failed to add reaction");
      }
    },

    'chat:delete': async (payload: { conversationId: string; messageId: string; accessToken: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:delete", userId, ip, RL_DELETE);
        if (!rl.allowed) {
          socket.emit("chat:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || !payload.conversationId || !payload.messageId || !payload.accessToken) {
          socket.emit("chat:error", "Invalid delete payload");
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const message = await getMessageById(payload.conversationId, payload.messageId);
        if (!message) { socket.emit("chat:error", "Message not found"); return; }

        if (message.sender_server_id !== auth.tokenPayload.serverUserId && auth.role !== "owner") {
          socket.emit("chat:error", "You can only delete your own messages");
          return;
        }

        const deleted = await deleteMessage(payload.conversationId, payload.messageId);
        if (!deleted) { socket.emit("chat:error", "Failed to delete message"); return; }

        const existing = messageCache.get(payload.conversationId);
        if (existing?.items) {
          messageCache.set(payload.conversationId, {
            items: existing.items.filter((m) => m.message_id !== payload.messageId),
            fetchedAt: existing.fetchedAt,
          });
        }

        io.emit("chat:deleted", { conversation_id: payload.conversationId, message_id: payload.messageId });
      } catch (err) {
        consola.error("chat:delete failed", err);
        socket.emit("chat:error", "Failed to delete message");
      }
    },

    'chat:edit': async (payload: { conversationId: string; messageId: string; text: string; accessToken: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:edit", userId, ip, RL_EDIT);
        if (!rl.allowed) {
          socket.emit("chat:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }

        if (!payload || !payload.conversationId || !payload.messageId || typeof payload.text !== "string" || !payload.accessToken) {
          socket.emit("chat:error", "Invalid edit payload");
          return;
        }

        const text = payload.text.trim();
        if (!text) {
          socket.emit("chat:error", "Edited message cannot be empty");
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const message = await getMessageById(payload.conversationId, payload.messageId);
        if (!message) { socket.emit("chat:error", "Message not found"); return; }

        if (message.sender_server_id !== auth.tokenPayload.serverUserId) {
          socket.emit("chat:error", "You can only edit your own messages");
          return;
        }

        const updated = await updateMessageText(payload.conversationId, payload.messageId, text);
        if (!updated) { socket.emit("chat:error", "Failed to edit message"); return; }

        const user = await getUserByServerId(auth.tokenPayload.serverUserId);
        let enriched: MessageRecord = {
          ...updated,
          sender_nickname: user?.nickname ?? "Unknown",
          sender_avatar_file_id: user?.avatar_file_id,
        };
        const [withAttachments] = await enrichAttachments([enriched]);
        enriched = withAttachments;

        const existing = messageCache.get(payload.conversationId);
        if (existing?.items) {
          messageCache.set(payload.conversationId, {
            items: existing.items.map((m) => m.message_id === updated.message_id ? updated : m),
            fetchedAt: existing.fetchedAt,
          });
        }

        const connectedClients = Object.entries(clientsInfo).filter(([, ci]) => {
          if (isConversationAVoiceChannel(payload.conversationId, sfuClient)) {
            return isUserConnectedToSpecificVoiceChannel(ci.serverUserId, payload.conversationId, sfuClient);
          }
          return true;
        });

        connectedClients.forEach(([cid]) => {
          io.sockets.sockets.get(cid)?.emit("chat:edited", enriched);
        });
      } catch (err) {
        consola.error("chat:edit failed", err);
        socket.emit("chat:error", "Failed to edit message");
      }
    },
  };
}
