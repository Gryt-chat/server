/**
 * The row, the attachment bytes, the first-page cache, `chat:deleted` and the
 * thread counters, in that order. Authorisation is the caller's.
 */

import consola from "consola";
import type { Server } from "socket.io";

import {
  decrementThreadReply,
  deleteMessage,
  deleteThread,
  getThreadByRoot,
} from "../db";
import type { MessageRecord } from "../db/interfaces";
import { deleteUnreferencedFiles } from "../jobs/mediaSweep";
import type { SFUClient } from "../sfu/client";
import type { Clients } from "../types";
import type { AllowedConversationAccess } from "../socket/utils/conversationAccess";
import { dropCachedMessage } from "../socket/utils/messageCache";
import { recipientClientIds } from "../socket/utils/recipients";

export interface DeleteMessageParams {
  io: Server;
  clientsInfo: Clients;
  sfuClient: SFUClient | null;
  conversationId: string;
  messageId: string;
  /** Passed in rather than re-read: every caller already fetched it, and reading
      again opens a window where it is gone before its attachments are found. */
  message: MessageRecord;
  access: AllowedConversationAccess;
  /** Injectable so a test can watch it: this is the step most likely to be lost
      in a refactor and the least likely to be noticed. */
  cleanUpAttachments?: (fileIds: string[]) => Promise<unknown>;
}

/** False when the row was not deleted. Nothing else runs, because telling
    everybody a message is gone when it is not is worse than the failure. */
export async function deleteMessageEverywhere({
  io,
  clientsInfo,
  sfuClient,
  conversationId,
  messageId,
  message,
  access,
  cleanUpAttachments = deleteUnreferencedFiles,
}: DeleteMessageParams): Promise<boolean> {
  const deleted = await deleteMessage(conversationId, messageId);
  if (!deleted) return false;

  const attachmentIds = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachmentIds.length > 0) {
    void cleanUpAttachments(attachmentIds).catch((e) =>
      consola.warn("attachment cleanup after delete failed", e),
    );
  }

  dropCachedMessage(conversationId, messageId);

  const recipients = recipientClientIds(conversationId, access, clientsInfo, sfuClient);
  recipients.forEach((cid) => {
    io.sockets.sockets
      .get(cid)
      ?.emit("chat:deleted", { conversation_id: conversationId, message_id: messageId });
  });

  if (message.thread_id) {
    const bumped = await decrementThreadReply(message.thread_id);
    if (bumped) {
      const upd = {
        conversation_id: bumped.conversation_id,
        thread_id: bumped.thread_id,
        root_message_id: bumped.root_message_id,
        reply_count: bumped.reply_count,
        last_message_at: bumped.last_message_at.toISOString(),
        status: bumped.status,
      };
      recipients.forEach((cid) => io.sockets.sockets.get(cid)?.emit("thread:updated", upd));
    }
    return true;
  }

  /* Not a reply, so it may be a root — and deleting a root takes its thread and
     every reply in it. GRYT-981. */
  const rootThread = await getThreadByRoot(messageId);
  if (rootThread) {
    const removed = await deleteThread(rootThread.thread_id);
    if (removed) {
      recipients.forEach((cid) =>
        io.sockets.sockets.get(cid)?.emit("thread:deleted", {
          conversation_id: removed.conversation_id,
          thread_id: rootThread.thread_id,
          root_message_id: removed.root_message_id,
        }),
      );
    }
  }

  return true;
}
