import consola from "consola";

import { randomUUID } from "crypto";
import type { HandlerContext, EventHandlerMap } from "./types";
import { requireAuth } from "../middleware/auth";
import { isBotIdentity } from "../../auth/identity";
import { socketMay } from "../utils/standing";
import {
  insertMessage,
  listMessages,
  listServerChannels,
  getServerChannel,
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
  getWebhooksByIds,
  clearConversationHidden,
  getConversation,
  touchConversation,
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE as MAX_ATTACHMENTS_PER_MESSAGE,
  blockersOfSender,
  blockedServerIdsFor,
  getAllRegisteredUsers,
  recordMentions,
  createThread,
  getThread,
  getThreadByRoot,
  bumpThreadOnReply,
  listThreadMessages,
  listThreadsByConversation,
  countThreadParticipants,
  setThreadStatus,
  setThreadTags,
} from "../../db";
import { processProfanity, type CensorStyle, type ProfanityMode } from "../../utils/profanityFilter";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { textMuteError, textMuteFor } from "../../moderation/textMute";
import { MESSAGE_MAX_LENGTH, MESSAGE_TOO_LONG, SEALED_MAX_LENGTH } from "../../utils/messageLimits";
import { applyAutoRoles } from "../../services/autoRoles";
import { findMentions, type MentionableMember } from "../../services/mentions";
import { mayInChannel } from "../../services/channelPermissions";
import { pluginEvents } from "../../plugins";
import { deleteMessageEverywhere } from "../../moderation/deleteMessage";
import { broadcastServerUiUpdate } from "../utils/server";
import { directConversationViews } from "./dm";
import {
  DENIAL_RESPONSES,
  resolveConversationAccess,
  type AllowedConversationAccess,
} from "../utils/conversationAccess";
import {
  isConversationAVoiceChannel,
  isUserConnectedToSpecificVoiceChannel,
  recipientClientIds as recipientsOf,
} from "../utils/recipients";
import {
  appendCachedMessage,
  dropCachedMessage,
  getMessagesCached,
  replaceCachedMessage,
  sweepMessageCache,
} from "../utils/messageCache";

const RL_SEND: RateLimitRule = { limit: 20, windowMs: 10_000, banMs: 30_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 2000 };
const RL_REACT: RateLimitRule = { limit: 60, windowMs: 60_000, scorePerAction: 0.5, maxScore: 15, scoreDecayMs: 3000 };
const RL_DELETE: RateLimitRule = { limit: 30, windowMs: 60_000, scorePerAction: 1, maxScore: 15, scoreDecayMs: 3000 };
const RL_EDIT: RateLimitRule = { limit: 20, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 2000 };
const RL_FETCH: RateLimitRule = { limit: 15, windowMs: 10_000, scorePerAction: 0.3, maxScore: 8, scoreDecayMs: 1500 };

/* The whole users table, read on the way out of every message with an `@`.
   Stale one way only: a very recent joiner is not matched yet. */
const MENTIONABLE_TTL_MS = 30_000;
let mentionableCache: { members: MentionableMember[]; fetchedAt: number } | null = null;

async function getMentionableMembers(): Promise<MentionableMember[]> {
  const now = Date.now();
  if (mentionableCache && now - mentionableCache.fetchedAt < MENTIONABLE_TTL_MS) {
    return mentionableCache.members;
  }
  const members = (await getAllRegisteredUsers()).map((u) => ({
    serverUserId: u.server_user_id,
    nickname: u.nickname,
  }));
  mentionableCache = { members, fetchedAt: now };
  return members;
}

const NONCE_TTL_MS = 60_000;
const recentNonces = new Map<string, { message: MessageRecord; createdAt: number }>();

setInterval(() => {
  const now = Date.now();
  sweepMessageCache(now);
  for (const [nonce, entry] of recentNonces) {
    if (now - entry.createdAt > NONCE_TTL_MS) recentNonces.delete(nonce);
  }
}, 60_000).unref();

let channelTextCache: { channels: Map<string, boolean>; fetchedAt: number } | null = null;
const CHANNEL_TEXT_CACHE_TTL = 15_000;

async function isTextInVoiceEnabled(channelId: string): Promise<boolean> {
  const now = Date.now();
  if (!channelTextCache || now - channelTextCache.fetchedAt > CHANNEL_TEXT_CACHE_TTL) {
    const chans = await listServerChannels();
    channelTextCache = {
      channels: new Map(chans.map((c) => [c.channel_id, c.text_in_voice])),
      fetchedAt: now,
    };
  }
  return channelTextCache.channels.get(channelId) === true;
}

const WEBHOOK_PREFIX = "webhook:";

async function enrichMessages(messages: MessageRecord[]): Promise<MessageRecord[]> {
  const senderIds = [...new Set(messages.map(m => m.sender_server_id).filter(Boolean))];
  if (senderIds.length === 0) return messages;

  const webhookIds = senderIds
    .filter(id => id.startsWith(WEBHOOK_PREFIX))
    .map(id => id.slice(WEBHOOK_PREFIX.length));
  const userIds = senderIds.filter(id => !id.startsWith(WEBHOOK_PREFIX));

  const [userMap, webhookMap] = await Promise.all([
    userIds.length > 0 ? getUsersByServerIds(userIds) : Promise.resolve(new Map()),
    webhookIds.length > 0 ? getWebhooksByIds(webhookIds) : Promise.resolve(new Map()),
  ]);

  return messages.map(m => {
    if (m.sender_server_id.startsWith(WEBHOOK_PREFIX)) {
      const whId = m.sender_server_id.slice(WEBHOOK_PREFIX.length);
      const wh = webhookMap.get(whId);
      return {
        ...m,
        sender_nickname: m.sender_nickname ?? wh?.display_name ?? "Webhook",
        sender_avatar_file_id: m.sender_avatar_file_id ?? wh?.avatar_file_id ?? undefined,
      };
    }
    const info = userMap.get(m.sender_server_id);
    return {
      ...m,
      sender_nickname: info?.nickname ?? "Unknown",
      sender_avatar_file_id: info?.avatar_file_id,
      // On every message, not only the member list: deciding whether a person
      // wrote it should not need a cross-reference to the sidebar.
      sender_is_bot: isBotIdentity(info?.gryt_user_id),
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

  const result: MessageRecord[] = [];
  for (const m of messages) {
    if (!m.attachments || m.attachments.length === 0) { result.push(m); continue; }

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

    const hasText = !!m.text?.trim();
    const allMissing = enriched.every(a => a.mime === null);
    if (!hasText && allMissing) {
      deleteMessage(m.conversation_id, m.message_id).catch(err =>
        consola.warn("Auto-pruned empty message with missing attachments", m.message_id, err),
      );
      dropCachedMessage(m.conversation_id, m.message_id);
      continue;
    }

    result.push({ ...m, enriched_attachments: enriched });
  }

  return result;
}


export function registerChatHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient, getClientIp } = ctx;

  /** Who hears about a conversation, minus anybody who blocked the sender.
      Filtered here because a sealed DM cannot be filtered anywhere else. */
  async function deliverableClientIds(
    conversationId: string,
    access: AllowedConversationAccess,
    senderServerUserId: string,
  ): Promise<string[]> {
    const blockers = await blockersOfSender(senderServerUserId);
    const all = recipientClientIds(conversationId, access);
    if (blockers.size === 0) return all;

    /* The sender keeps their own copy: a message that vanished as it was sent
       would read as a failure to send. */
    return all.filter(
      (cid) =>
        clientsInfo[cid]?.serverUserId === senderServerUserId ||
        !blockers.has(clientsInfo[cid]?.serverUserId ?? ""),
    );
  }

  /* The shared answer, with this connection's two refs already filled in, so
     every call site below reads the way it did before it moved. */
  function recipientClientIds(conversationId: string, access: AllowedConversationAccess): string[] {
    return recipientsOf(conversationId, access, clientsInfo, sfuClient);
  }

  /** Emits the refusal itself and returns null, so every call site is one
      `if (!access) return;`. */
  async function requireConversationAccess(
    conversationId: string,
    serverUserId: string | null | undefined,
  ): Promise<AllowedConversationAccess | null> {
    const access = await resolveConversationAccess(conversationId, serverUserId);
    if (!access.allowed) {
      const { error, message } = DENIAL_RESPONSES[access.reason];
      socket.emit("chat:error", { error, message });
      return null;
    }
    return access;
  }

  return {
    'chat:send': async (payload: { conversationId: string; accessToken: string; text?: string; sealed?: string; attachments?: string[]; replyToMessageId?: string; threadId?: string; nonce?: string }) => {
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

        const auth = await requireAuth(socket, payload, { permission: "send_messages" });
        if (!auth) return;

        // A mute covers text as well as voice (GRYT-917).
        const sendMute = await textMuteFor(auth.tokenPayload.serverUserId);
        if (sendMute.muted) {
          socket.emit("chat:error", textMuteError(sendMute));
          return;
        }

        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;

        // `send_messages` is whether they may talk, the scope whether they may
        // talk here. A DM has no scope and falls through to the first.
        if (!(await mayInChannel(payload.conversationId, auth.tokenPayload.serverUserId, "send_messages", auth.tokenPayload.grytUserId))) {
          socket.emit("chat:error", {
            error: "forbidden",
            message: "This channel is read-only for your role.",
          });
          return;
        }

        // Webhooks and system messages insert directly and never reach here,
        // so an automated channel just means: humans refused, bots not.
        const automatedChannel = access.kind === "dm" ? null : await getServerChannel(payload.conversationId);
        if (automatedChannel?.automated && !isBotIdentity(auth.tokenPayload.grytUserId)) {
          socket.emit("chat:error", {
            error: "automated_channel",
            message: "This is an automated channel — only bots and the system can post here.",
          });
          return;
        }

        // Same channel and permissions as any other message, plus a thread_id
        // so the client can place it. Threads live in channels, not DMs.
        let threadId: string | null = null;
        if (typeof payload.threadId === "string" && payload.threadId) {
          if (access.kind === "dm") {
            socket.emit("chat:error", { error: "threads_not_allowed", message: "Threads are not available in direct messages." });
            return;
          }
          const thread = await getThread(payload.threadId);
          if (!thread || thread.conversation_id !== payload.conversationId) {
            socket.emit("chat:error", { error: "thread_not_found", message: "That thread no longer exists." });
            return;
          }
          if (thread.locked || thread.status === "closed") {
            socket.emit("chat:error", { error: "thread_closed", message: "This thread is closed to new replies." });
            return;
          }
          threadId = thread.thread_id;
        }

        // Identity verification
        if (userId && payload.accessToken) {
          const identityValid = await verifyUserIdentity(auth.tokenPayload.serverUserId, auth.tokenPayload.grytUserId);
          if (!identityValid) { socket.emit("chat:error", "Identity verification failed"); return; }
        }

        // Voice channel gate
        if (userId && isConversationAVoiceChannel(payload.conversationId, sfuClient)) {
          if (!await isTextInVoiceEnabled(payload.conversationId)) {
            socket.emit("chat:error", "Text chat is disabled in this voice channel");
            return;
          }
          if (!isUserConnectedToSpecificVoiceChannel(userId, payload.conversationId, sfuClient)) {
            socket.emit("chat:error", "You must be connected to this voice channel to send messages");
            return;
          }
        }

        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        const sealed = typeof payload.sealed === "string" ? payload.sealed : null;
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : null;
        if (!text && !sealed && (!attachments || attachments.length === 0)) {
          socket.emit("chat:error", "Message is empty");
          return;
        }

        /* Refused rather than picking one: whichever is kept, the other was
           already written down. */
        if (sealed && text) {
          socket.emit("chat:error", "A message is sealed or it is not.");
          return;
        }

        // Generous next to a real envelope, which the member cap already
        // bounds. A cap at all, so the column is not a place to park data.
        if (sealed && sealed.length > SEALED_MAX_LENGTH) {
          socket.emit("chat:error", "That message is too large to send encrypted.");
          return;
        }

        // Refused rather than truncated, so somebody can see what they would
        // lose and decide.
        if (text.length > MESSAGE_MAX_LENGTH) {
          socket.emit("chat:error", MESSAGE_TOO_LONG);
          return;
        }

        // Also at the upload endpoint, but an id can be reused from an earlier
        // message. This caps how many; the size limit is per file.
        if (attachments && attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
          socket.emit("chat:error", {
            error: "too_many_attachments",
            message: `A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`,
          });
          return;
        }

        if (attachments && attachments.length > 0 && !auth.permissions.has("attach_files")) {
          socket.emit("chat:error", {
            error: "forbidden",
            message: "You do not have permission to attach files here.",
            permission: "attach_files",
          });
          return;
        }

        const cfg = await getServerConfig().catch(() => null);

        // Switching DMs off stops new ones without hiding what is there, so
        // turning it back on has nothing to undo.
        if (access.kind === "dm" && cfg && cfg.allow_dms === false) {
          socket.emit("chat:error", { error: "dms_disabled", message: "Direct messages are turned off on this server" });
          return;
        }

        /* A channel has no fixed set of keys to seal to, so anybody admitted
           later would find every message unreadable. */
        if (sealed && access.kind !== "dm") {
          socket.emit("chat:error", {
            error: "sealed_not_allowed",
            message: "Only direct messages can be encrypted.",
          });
          return;
        }

        if (access.kind === "dm" && !auth.permissions.has("send_direct_messages")) {
          socket.emit("chat:error", {
            error: "forbidden",
            message: "You do not have permission to send direct messages here.",
            permission: "send_direct_messages",
          });
          return;
        }

        if (attachments && attachments.length > 0) {
          const fileMap = await getFilesByIds(attachments);
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

        const profanityMode: ProfanityMode = cfg?.profanity_mode ?? "off";
        const censorStyle: CensorStyle = cfg?.profanity_censor_style ?? "grawlix";
        let finalText = text;
        let profanityMatches: { startIndex: number; endIndex: number }[] | undefined;

        // A sealed message has no text here to filter or moderate.
        // `finalText` stays empty so nothing below reads it.
        if (profanityMode !== "off" && finalText) {
          const result = await processProfanity(finalText, profanityMode, censorStyle);
          if (result.action === "reject") {
            socket.emit("chat:error", "Message blocked: contains profanity.");
            return;
          }
          finalText = result.text;
          profanityMatches = result.matches;
        }

        // A resend. The nonce travels back or the retrying client cannot tell
        // this is the message it holds and draws it twice.
        if (payload.nonce && recentNonces.has(payload.nonce)) {
          const cached = recentNonces.get(payload.nonce)!;
          socket.emit("chat:new", { ...cached.message, nonce: payload.nonce });
          return;
        }

        const created = await insertMessage({
          conversation_id: payload.conversationId,
          sender_server_id: auth.tokenPayload.serverUserId,
          text: finalText || null,
          sealed,
          attachments: attachments && attachments.length > 0 ? attachments : null,
          reactions: null,
          reply_to_message_id: replyToMessageId,
          thread_id: threadId,
        });

        let enriched: MessageRecord = {
          ...created,
          sender_nickname: user.nickname,
          sender_avatar_file_id: user.avatar_file_id,
          profanity_matches: profanityMatches,
        };
        const [withAttachments] = await enrichAttachments([enriched]);
        enriched = withAttachments;

        if (payload.nonce) {
          recentNonces.set(payload.nonce, { message: enriched, createdAt: Date.now() });
        }

        // A thread reply is kept out of the channel's first-page cache — it must
        // not leak into the main timeline. It bumps the thread counters instead.
        if (!threadId) {
          appendCachedMessage(created.conversation_id, created);
        }

        let threadUpdate:
          | { conversation_id: string; thread_id: string; root_message_id: string; reply_count: number; last_message_at: string; status: string }
          | null = null;
        if (threadId) {
          const bumped = await bumpThreadOnReply(threadId, created.created_at);
          if (bumped) {
            threadUpdate = {
              conversation_id: bumped.conversation_id,
              thread_id: bumped.thread_id,
              root_message_id: bumped.root_message_id,
              reply_count: bumped.reply_count,
              last_message_at: bumped.last_message_at.toISOString(),
              status: bumped.status,
            };
          }
        }

        if (access.kind === "dm") {
          /* Read before touching. A conversation with no messages is in nobody's
             list but its opener's, so the first one has to announce it. */
          const wasEmpty = !(await getConversation(created.conversation_id))?.last_message_at;

          await touchConversation(created.conversation_id, created.created_at).catch((err) =>
            consola.warn("touchConversation failed", created.conversation_id, err),
          );

          // A message unhides a conversation, since hiding only means "not in
          // my sidebar". After the send, and swallowed: it cannot block one.
          try {
            const restored = await clearConversationHidden(created.conversation_id);
            const announce = wasEmpty
              ? [...new Set([...restored, ...access.memberIds])]
              : restored;
            for (const serverUserId of announce) {
              const views = await directConversationViews(serverUserId);
              const view = views.find((v) => v.conversation_id === created.conversation_id);
              if (!view) continue;
              for (const [cid, ci] of Object.entries(clientsInfo)) {
                if (ci.serverUserId !== serverUserId) continue;
                io.sockets.sockets.get(cid)?.emit("dm:opened", view);
              }
            }
          } catch (err) {
            consola.warn("un-hiding the conversation failed", created.conversation_id, err);
          }
        }

        const recipients = await deliverableClientIds(
          created.conversation_id,
          access,
          auth.tokenPayload.serverUserId,
        );
        recipients.forEach((cid) => {
          const msg = cid === clientId && payload.nonce
            ? { ...enriched, nonce: payload.nonce }
            : enriched;
          io.sockets.sockets.get(cid)?.emit("chat:new", msg);
        });

        // The root's "N replies" summary and the thread's activity sort ride on
        // this, sent to the same audience that got the message. GRYT-981.
        if (threadUpdate) {
          recipients.forEach((cid) => io.sockets.sockets.get(cid)?.emit("thread:updated", threadUpdate));
        }

        /* After delivery, so no plugin can stop a message arriving. DMs and
           sealed messages are not offered at all rather than offered empty. */
        if (access.kind !== "dm" && !sealed) {
          pluginEvents().emit("message:created", {
            messageId: created.message_id,
            channelId: created.conversation_id,
            userId: created.sender_server_id,
            nickname: user.nickname ?? null,
            text: created.text ?? "",
            attachmentCount: created.attachments?.length ?? 0,
            at: created.created_at.toISOString(),
          });
        }

        /* After delivery, so a parse that threw cannot stop a message. Sealed
           messages are skipped: the server holds ciphertext. */
        if (finalText?.includes("@")) {
          try {
            const named = findMentions(finalText, await getMentionableMembers());
            if (named.length > 0) {
              const stored = await recordMentions({
                conversationId: created.conversation_id,
                messageId: created.message_id,
                senderServerUserId: auth.tokenPayload.serverUserId,
                serverUserIds: named,
              });

              // The row is what survives being offline. This is only what makes
              // it arrive without a refresh.
              const online = new Set(stored);
              for (const [cid, info] of Object.entries(clientsInfo)) {
                if (!info?.serverUserId || !online.has(info.serverUserId)) continue;
                if (!recipients.includes(cid)) continue;
                io.sockets.sockets.get(cid)?.emit("mention:new", {
                  conversationId: created.conversation_id,
                  messageId: created.message_id,
                  createdAt: created.created_at,
                  /* Null for a mention in the channel itself. Without it a
                     mention in a thread cannot say where in the channel. */
                  threadId: created.thread_id ?? null,
                });
              }
            }
          } catch (err) {
            consola.warn("recording mentions failed", created.message_id, err);
          }
        }

        // After the message is out, so a promotion can neither slow one down
        // nor stop one. One roles read on a server using none of this.
        const promoted = await applyAutoRoles(
          auth.tokenPayload.serverUserId,
          auth.tokenPayload.grytUserId,
        );
        if (promoted) {
          io.to("verifiedClients").emit("server:role:updated", {
            serverId,
            serverUserId: auth.tokenPayload.serverUserId,
            role: promoted.granted.role_id,
          });
          // Their permissions ride on server details, so without this the tier
          // they just earned does nothing until they reconnect.
          broadcastServerUiUpdate("other");
        }
      } catch (err) {
        consola.error("chat:send failed", err);
        try {
          const now = new Date();
          const fallback: MessageRecord & { ephemeral: boolean } = {
            conversation_id: payload?.conversationId || "unknown",
            message_id: randomUUID(),
            sender_server_id: "unknown",
            text: payload?.text || null,
            attachments: payload?.attachments?.length ? payload.attachments : null,
            created_at: now,
            reactions: null,
            ephemeral: true,
          };
          // Resolved again because `access` belongs to the try above. Anything
          // but a clear yes means the sender alone hears about it.
          const fallbackAccess = await resolveConversationAccess(
            fallback.conversation_id,
            clientsInfo[clientId]?.serverUserId,
          ).catch(() => null);

          const fallbackRecipients = fallbackAccess?.allowed
            ? recipientClientIds(fallback.conversation_id, fallbackAccess)
            : [clientId];

          fallbackRecipients.forEach((cid) => {
            io.sockets.sockets.get(cid)?.emit("chat:new", fallback);
          });
          socket.emit("chat:error", "Message not persisted (temporary storage issue)");
        } catch { socket.emit("chat:error", "Failed to send message"); }
      }
    },

    'chat:fetch': async (payload: { conversationId: string; limit?: number; before?: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        // No access token: history is asked for off an already-verified socket,
        // so the permission is read from who the socket is.
        if (!(await socketMay(clientsInfo, clientId, "read_messages"))) {
          socket.emit("chat:error", {
            error: "forbidden",
            message: "You do not have permission to read this channel.",
            permission: "read_messages",
          });
          return;
        }
        const rl = checkRateLimit("chat:fetch", userId, ip, RL_FETCH);
        if (!rl.allowed) {
          socket.emit("chat:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string") { socket.emit("chat:error", "Invalid fetch payload"); return; }

        // `read_messages` says they may read channels here, not that this
        // conversation is one of theirs, which is the DM question.
        if (!(await requireConversationAccess(payload.conversationId, userId))) return;

        if (userId && isConversationAVoiceChannel(payload.conversationId, sfuClient)) {
          if (!await isTextInVoiceEnabled(payload.conversationId)) {
            socket.emit("chat:error", "Text chat is disabled in this voice channel");
            return;
          }
          if (!isUserConnectedToSpecificVoiceChannel(userId, payload.conversationId, sfuClient)) {
            socket.emit("chat:error", "You must be connected to this voice channel");
            return;
          }
        }

        const limit = typeof payload.limit === "number" ? payload.limit : 50;
        const before = typeof payload.before === "string" ? new Date(payload.before) : undefined;
        consola.info("[chat:fetch]", { conversationId: payload.conversationId, limit, before: before?.toISOString(), hasBefore: !!before });
        const items = before
          ? await listMessages(payload.conversationId, limit, before)
          : await getMessagesCached(payload.conversationId, limit);
        /* Before enrichment, so nothing is spent on an avatar nobody sees.
           `hasMore` counts what is left, so a page may come back short. */
        const hidden = await blockedServerIdsFor(clientsInfo[clientId]?.serverUserId ?? "");
        const visible = hidden.size === 0
          ? items
          : items.filter((m) => !hidden.has(m.sender_server_id));

        let enrichedItems = await enrichMessages(visible);
        enrichedItems = await enrichAttachments(enrichedItems);
        const response: { conversation_id: string; items: typeof enrichedItems; hasMore: boolean; before?: string } = {
          conversation_id: payload.conversationId,
          items: enrichedItems,
          hasMore: enrichedItems.length >= limit,
        };
        consola.info("[chat:fetch] response", { itemCount: enrichedItems.length, hasMore: response.hasMore, before: response.before });
        if (before) response.before = payload.before;
        socket.emit("chat:history", response);
      } catch (err) {
        consola.error("chat:fetch failed", err);
        socket.emit("chat:error", "Failed to fetch messages");
      }
    },

    // Start a thread from an existing message. No message is posted here; the
    // first reply is a normal chat:send carrying this thread's id. GRYT-981.
    'thread:create': async (payload: { conversationId: string; rootMessageId: string; accessToken: string; title?: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:send", userId, ip, RL_SEND);
        if (!rl.allowed) {
          socket.emit("thread:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string" || typeof payload.rootMessageId !== "string" || typeof payload.accessToken !== "string") {
          socket.emit("thread:error", "Invalid payload");
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "send_messages" });
        if (!auth) return;
        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;
        if (access.kind === "dm") {
          socket.emit("thread:error", { error: "threads_not_allowed", message: "Threads are not available in direct messages." });
          return;
        }
        if (!(await mayInChannel(payload.conversationId, auth.tokenPayload.serverUserId, "send_messages", auth.tokenPayload.grytUserId))) {
          socket.emit("thread:error", { error: "forbidden", message: "This channel is read-only for your role." });
          return;
        }
        const root = await getMessageById(payload.conversationId, payload.rootMessageId);
        if (!root) { socket.emit("thread:error", "Message not found"); return; }
        if (root.thread_id) { socket.emit("thread:error", { error: "already_in_thread", message: "You can't start a thread from a message that is already in one." }); return; }

        // Idempotent: a double click, or two people at once, resolves to one
        // thread. The unique index on root_message_id is the backstop.
        const existing = await getThreadByRoot(payload.rootMessageId);
        const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim().slice(0, 200) : null;
        const thread = existing ?? await createThread({
          conversation_id: payload.conversationId,
          root_message_id: payload.rootMessageId,
          created_by: auth.tokenPayload.serverUserId,
          title,
        });
        const summary = {
          thread_id: thread.thread_id,
          conversation_id: thread.conversation_id,
          root_message_id: thread.root_message_id,
          title: thread.title,
          created_by: thread.created_by,
          status: thread.status,
          reply_count: thread.reply_count,
          locked: thread.locked,
          created_at: thread.created_at.toISOString(),
          last_message_at: thread.last_message_at.toISOString(),
        };
        (await deliverableClientIds(payload.conversationId, access, auth.tokenPayload.serverUserId))
          .forEach((cid) => io.sockets.sockets.get(cid)?.emit("thread:created", summary));
      } catch (err) {
        consola.error("thread:create failed", err);
        socket.emit("thread:error", "Failed to create thread");
      }
    },

    // The replies inside a thread, plus its root, for when a thread panel opens.
    // Token-less like chat:fetch: permission comes from the verified socket.
    'thread:fetch': async (payload: { conversationId: string; threadId: string; limit?: number; before?: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        if (!(await socketMay(clientsInfo, clientId, "read_messages"))) {
          socket.emit("thread:error", { error: "forbidden", message: "You do not have permission to read this channel.", permission: "read_messages" });
          return;
        }
        const rl = checkRateLimit("chat:fetch", userId, ip, RL_FETCH);
        if (!rl.allowed) {
          socket.emit("thread:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string" || typeof payload.threadId !== "string") {
          socket.emit("thread:error", "Invalid fetch payload");
          return;
        }
        if (!(await requireConversationAccess(payload.conversationId, userId))) return;
        const thread = await getThread(payload.threadId);
        if (!thread || thread.conversation_id !== payload.conversationId) {
          socket.emit("thread:error", { error: "thread_not_found", message: "That thread no longer exists." });
          return;
        }
        const limit = typeof payload.limit === "number" ? payload.limit : 50;
        const before = typeof payload.before === "string" ? new Date(payload.before) : undefined;

        const hidden = await blockedServerIdsFor(clientsInfo[clientId]?.serverUserId ?? "");
        const replies = await listThreadMessages(payload.threadId, limit, before);
        const visible = hidden.size === 0 ? replies : replies.filter((m) => !hidden.has(m.sender_server_id));
        /* Before the block filter, unlike chat:fetch: a page that is entirely
           blocked senders would otherwise end the scrollback. */
        const hasMore = replies.length >= limit;
        let items = await enrichMessages(visible);
        items = await enrichAttachments(items);
        /* First page only: sending the root with every page would redraw the
           topic above the divider on each scroll. */
        let root: (typeof items)[number] | null = null;
        if (!before) {
          const rootRaw = await getMessageById(payload.conversationId, thread.root_message_id);
          if (rootRaw && (hidden.size === 0 || !hidden.has(rootRaw.sender_server_id))) {
            const [enrichedRoot] = await enrichAttachments(await enrichMessages([rootRaw]));
            root = enrichedRoot ?? null;
          }
        }
        socket.emit("thread:history", {
          conversation_id: payload.conversationId,
          thread: {
            thread_id: thread.thread_id,
            conversation_id: thread.conversation_id,
            root_message_id: thread.root_message_id,
            title: thread.title,
            created_by: thread.created_by,
            status: thread.status,
            reply_count: thread.reply_count,
            locked: thread.locked,
            created_at: thread.created_at.toISOString(),
            last_message_at: thread.last_message_at.toISOString(),
          },
          root,
          items,
          hasMore,
          ...(before ? { before: payload.before } : {}),
        });
      } catch (err) {
        consola.error("thread:fetch failed", err);
        socket.emit("thread:error", "Failed to fetch thread");
      }
    },

    // Author or moderator. 'solved' stays repliable; 'closed' stops new
    // replies, which chat:send checks.
    'thread:status:set': async (payload: { conversationId: string; threadId: string; status: string; accessToken: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:edit", userId, ip, RL_EDIT);
        if (!rl.allowed) {
          socket.emit("thread:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string" || typeof payload.threadId !== "string" || typeof payload.accessToken !== "string") {
          socket.emit("thread:error", "Invalid payload");
          return;
        }
        const status = payload.status;
        if (status !== "open" && status !== "solved" && status !== "closed") {
          socket.emit("thread:error", { error: "bad_status", message: "A topic is open, solved or closed." });
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "send_messages" });
        if (!auth) return;
        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;
        const thread = await getThread(payload.threadId);
        if (!thread || thread.conversation_id !== payload.conversationId) {
          socket.emit("thread:error", { error: "thread_not_found", message: "That thread no longer exists." });
          return;
        }
        // The author can settle their own topic; everyone else needs the
        // moderator permission.
        const isAuthor = thread.created_by === auth.tokenPayload.serverUserId;
        if (!isAuthor && !auth.permissions.has("manage_messages")) {
          socket.emit("thread:error", { error: "forbidden", message: "Only the topic's author or a moderator can change this.", permission: "manage_messages" });
          return;
        }
        const updated = await setThreadStatus(payload.threadId, status);
        if (!updated) { socket.emit("thread:error", "Failed to update the topic."); return; }
        const upd = {
          conversation_id: updated.conversation_id,
          thread_id: updated.thread_id,
          root_message_id: updated.root_message_id,
          reply_count: updated.reply_count,
          last_message_at: updated.last_message_at.toISOString(),
          status: updated.status,
        };
        recipientClientIds(payload.conversationId, access).forEach((cid) =>
          io.sockets.sockets.get(cid)?.emit("thread:updated", upd),
        );
      } catch (err) {
        consola.error("thread:status:set failed", err);
        socket.emit("thread:error", "Failed to update the topic.");
      }
    },

    // Change a topic's tags. The author or a moderator may; unknown tag ids are
    // dropped against the channel's palette. GRYT-981 Stage 3.
    'thread:tags:set': async (payload: { conversationId: string; threadId: string; tagIds: string[]; accessToken: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:edit", userId, ip, RL_EDIT);
        if (!rl.allowed) {
          socket.emit("thread:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string" || typeof payload.threadId !== "string" || !Array.isArray(payload.tagIds) || typeof payload.accessToken !== "string") {
          socket.emit("thread:error", "Invalid payload");
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "send_messages" });
        if (!auth) return;
        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;
        const thread = await getThread(payload.threadId);
        if (!thread || thread.conversation_id !== payload.conversationId) {
          socket.emit("thread:error", { error: "thread_not_found", message: "That thread no longer exists." });
          return;
        }
        const isAuthor = thread.created_by === auth.tokenPayload.serverUserId;
        if (!isAuthor && !auth.permissions.has("manage_messages")) {
          socket.emit("thread:error", { error: "forbidden", message: "Only the topic's author or a moderator can change this.", permission: "manage_messages" });
          return;
        }
        const channel = await getServerChannel(payload.conversationId);
        const validTagIds = new Set((channel?.forum_tags ?? []).map((t) => t.id));
        const tags = payload.tagIds.filter((id) => typeof id === "string" && validTagIds.has(id)).slice(0, 20);
        const updated = await setThreadTags(payload.threadId, tags);
        if (!updated) { socket.emit("thread:error", "Failed to update the topic."); return; }
        const upd = {
          conversation_id: updated.conversation_id,
          thread_id: updated.thread_id,
          root_message_id: updated.root_message_id,
          reply_count: updated.reply_count,
          last_message_at: updated.last_message_at.toISOString(),
          status: updated.status,
          tags: updated.tags,
        };
        recipientClientIds(payload.conversationId, access).forEach((cid) =>
          io.sockets.sockets.get(cid)?.emit("thread:updated", upd),
        );
      } catch (err) {
        consola.error("thread:tags:set failed", err);
        socket.emit("thread:error", "Failed to update the topic.");
      }
    },

    // Every thread as a summary row, with root preview, author and participant
    // count. Token-less, like chat:fetch.
    'forum:topics': async (payload: { conversationId: string }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        if (!(await socketMay(clientsInfo, clientId, "read_messages"))) {
          socket.emit("forum:error", { error: "forbidden", message: "You do not have permission to read this channel.", permission: "read_messages" });
          return;
        }
        const rl = checkRateLimit("chat:fetch", userId, ip, RL_FETCH);
        if (!rl.allowed) {
          socket.emit("forum:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string") { socket.emit("forum:error", "Invalid payload"); return; }
        if (!(await requireConversationAccess(payload.conversationId, userId))) return;

        const threads = await listThreadsByConversation(payload.conversationId);
        const rootRecords = (await Promise.all(
          threads.map((t) => getMessageById(payload.conversationId, t.root_message_id)),
        )).filter((r): r is MessageRecord => !!r);
        const enrichedRoots = await enrichMessages(rootRecords);
        const rootById = new Map(enrichedRoots.map((r) => [r.message_id, r]));

        const topics = await Promise.all(threads.map(async (t) => {
          const root = rootById.get(t.root_message_id);
          const participantCount = await countThreadParticipants(t.thread_id, t.root_message_id);
          return {
            thread_id: t.thread_id,
            conversation_id: t.conversation_id,
            root_message_id: t.root_message_id,
            title: t.title,
            status: t.status,
            reply_count: t.reply_count,
            participant_count: participantCount,
            created_at: t.created_at.toISOString(),
            last_message_at: t.last_message_at.toISOString(),
            creator_server_id: t.created_by,
            creator_nickname: root?.sender_nickname ?? null,
            creator_avatar_file_id: root?.sender_avatar_file_id ?? null,
            tags: t.tags,
            preview: root?.text ? root.text.slice(0, 200) : null,
          };
        }));
        socket.emit("forum:topics:list", { conversation_id: payload.conversationId, topics });
      } catch (err) {
        consola.error("forum:topics failed", err);
        socket.emit("forum:error", "Failed to list topics");
      }
    },

    // Create a forum topic: one root message and a thread with a title, made
    // together. GRYT-981 Stage 2.
    'forum:topic:create': async (payload: { conversationId: string; title: string; text?: string; accessToken: string; tagIds?: string[] }) => {
      try {
        const ip = getClientIp();
        const userId = clientsInfo[clientId]?.serverUserId;
        const rl = checkRateLimit("chat:send", userId, ip, RL_SEND);
        if (!rl.allowed) {
          socket.emit("forum:error", { error: "rate_limited", retryAfterMs: rl.retryAfterMs, message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.` });
          return;
        }
        if (!payload || typeof payload.conversationId !== "string" || typeof payload.title !== "string" || typeof payload.accessToken !== "string") {
          socket.emit("forum:error", "Invalid payload");
          return;
        }
        const auth = await requireAuth(socket, payload, { permission: "send_messages" });
        if (!auth) return;
        const sendMute = await textMuteFor(auth.tokenPayload.serverUserId);
        if (sendMute.muted) { socket.emit("forum:error", textMuteError(sendMute)); return; }
        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;
        if (access.kind === "dm") { socket.emit("forum:error", { error: "not_a_forum", message: "Topics can only be created in a channel." }); return; }
        if (!(await mayInChannel(payload.conversationId, auth.tokenPayload.serverUserId, "send_messages", auth.tokenPayload.grytUserId))) {
          socket.emit("forum:error", { error: "forbidden", message: "This channel is read-only for your role." });
          return;
        }
        const channel = await getServerChannel(payload.conversationId);
        if (channel?.automated && !isBotIdentity(auth.tokenPayload.grytUserId)) {
          socket.emit("forum:error", { error: "automated_channel", message: "This is an automated channel — only bots and the system can post here." });
          return;
        }
        const title = payload.title.trim().slice(0, 200);
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (!title) { socket.emit("forum:error", { error: "empty_title", message: "A topic needs a title." }); return; }
        if (!text) { socket.emit("forum:error", { error: "empty_body", message: "A topic needs a first message." }); return; }
        if (text.length > MESSAGE_MAX_LENGTH) { socket.emit("forum:error", MESSAGE_TOO_LONG); return; }

        const user = await getUserByServerId(auth.tokenPayload.serverUserId);
        if (!user) { socket.emit("forum:error", "User not found. Please rejoin."); return; }

        const created = await insertMessage({
          conversation_id: payload.conversationId,
          sender_server_id: auth.tokenPayload.serverUserId,
          text,
          attachments: null,
          reactions: null,
        });
        const validTagIds = new Set((channel?.forum_tags ?? []).map((t) => t.id));
        const tags = Array.isArray(payload.tagIds) ? payload.tagIds.filter((id) => validTagIds.has(id)).slice(0, 20) : [];
        const thread = await createThread({
          conversation_id: payload.conversationId,
          root_message_id: created.message_id,
          created_by: auth.tokenPayload.serverUserId,
          title,
          tags,
        });
        const summary = {
          thread_id: thread.thread_id,
          conversation_id: thread.conversation_id,
          root_message_id: thread.root_message_id,
          title: thread.title,
          created_by: thread.created_by,
          status: thread.status,
          reply_count: thread.reply_count,
          locked: thread.locked,
          created_at: thread.created_at.toISOString(),
          last_message_at: thread.last_message_at.toISOString(),
        };
        (await deliverableClientIds(payload.conversationId, access, auth.tokenPayload.serverUserId))
          .forEach((cid) => io.sockets.sockets.get(cid)?.emit("thread:created", summary));
        socket.emit("forum:topic:created", {
          ...summary,
          root: { ...created, sender_nickname: user.nickname, sender_avatar_file_id: user.avatar_file_id },
        });
      } catch (err) {
        consola.error("forum:topic:create failed", err);
        socket.emit("forum:error", "Failed to create topic");
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

        const auth = await requireAuth(socket, payload, { permission: "add_reactions" });
        if (!auth) return;

        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;

        const user = await getUserByServerId(auth.tokenPayload.serverUserId);
        if (!user) { socket.emit("chat:error", "User not found"); return; }

        const updatedMessage = await addReactionToMessage(payload.conversationId, payload.messageId, payload.reactionSrc, auth.tokenPayload.serverUserId);
        if (!updatedMessage) { socket.emit("chat:error", "Message not found"); return; }

        replaceCachedMessage(updatedMessage.conversation_id, updatedMessage);

        let [enrichedReaction] = await enrichMessages([updatedMessage]);
        [enrichedReaction] = await enrichAttachments([enrichedReaction]);
        recipientClientIds(updatedMessage.conversation_id, access).forEach((cid) => {
          io.sockets.sockets.get(cid)?.emit("chat:reaction", enrichedReaction);
        });
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

        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;

        const message = await getMessageById(payload.conversationId, payload.messageId);
        if (!message) { socket.emit("chat:error", "Message not found"); return; }

        const isOwnMessage = message.sender_server_id === auth.tokenPayload.serverUserId;
        const mayDelete = isOwnMessage
          ? auth.permissions.has("delete_own_messages") || auth.permissions.has("manage_messages")
          : auth.permissions.has("manage_messages");
        if (!mayDelete) {
          socket.emit("chat:error", {
            error: "forbidden",
            message: isOwnMessage
              ? "You do not have permission to delete messages here."
              : "You can only delete your own messages.",
            permission: isOwnMessage ? "delete_own_messages" : "manage_messages",
          });
          return;
        }

        // Bytes, cache, broadcast and thread counters in one place, because a
        // plugin deletes too and two copies drift.
        const deleted = await deleteMessageEverywhere({
          io,
          clientsInfo,
          sfuClient,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          message,
          access,
        });
        if (!deleted) { socket.emit("chat:error", "Failed to delete message"); return; }
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
        // The same cap as sending, because otherwise it is not a cap: send four
        // characters and edit them into four million.
        if (text.length > MESSAGE_MAX_LENGTH) {
          socket.emit("chat:error", MESSAGE_TOO_LONG);
          return;
        }
        if (!text) {
          socket.emit("chat:error", "Edited message cannot be empty");
          return;
        }

        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        // The same mute as sending. An edit is how four characters become four
        // million, and it is also how a muted member says something new.
        const editMute = await textMuteFor(auth.tokenPayload.serverUserId);
        if (editMute.muted) {
          socket.emit("chat:error", textMuteError(editMute));
          return;
        }

        const access = await requireConversationAccess(payload.conversationId, auth.tokenPayload.serverUserId);
        if (!access) return;

        const message = await getMessageById(payload.conversationId, payload.messageId);
        if (!message) { socket.emit("chat:error", "Message not found"); return; }

        // Own messages only, with no permission that opens it up: editing
        // somebody else's puts different words under their name.
        if (message.sender_server_id !== auth.tokenPayload.serverUserId) {
          socket.emit("chat:error", "You can only edit your own messages");
          return;
        }

        if (!auth.permissions.has("edit_own_messages")) {
          socket.emit("chat:error", {
            error: "forbidden",
            message: "You do not have permission to edit messages here.",
            permission: "edit_own_messages",
          });
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

        replaceCachedMessage(payload.conversationId, updated);

        const connectedClients = recipientClientIds(payload.conversationId, access);

        connectedClients.forEach((cid) => {
          io.sockets.sockets.get(cid)?.emit("chat:edited", enriched);
        });
      } catch (err) {
        consola.error("chat:edit failed", err);
        socket.emit("chat:error", "Failed to edit message");
      }
    },
  };
}
