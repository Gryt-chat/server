/**
 * Taking a message down, everywhere it exists (GRYT-936).
 *
 * A message is in five places, and deleting the row is only the first of them.
 * This module is the other four, and it exists because there is now more than
 * one thing that can delete a message: a member with `manage_messages`, and a
 * plugin. Two copies of a five-step operation drift, and the step that drifts
 * quietly is the attachment cleanup — where the failure is a deleted image
 * still being served to anybody holding the link.
 *
 * What has to happen, in order:
 *
 * 1. **The row.** If this fails nothing else should run, because the message is
 *    still there.
 * 2. **The attachment bytes.** The media sweep's grace period runs from upload,
 *    so a picture posted and deleted a minute later would sit in storage for
 *    the best part of an hour, reachable by URL. Not awaited: a storage backend
 *    having a bad minute must not turn a successful delete into a failure, and
 *    anything left behind is orphaned so the sweep still collects it.
 * 3. **The first-page cache.** Skip it and the message stays on the next
 *    person's screen until the entry ages out, which reads as a delete that did
 *    not work.
 * 4. **`chat:deleted`**, to everybody the conversation reaches.
 * 5. **The thread counters.** A reply leaving decrements its thread; a root
 *    leaving takes the whole thread with it.
 *
 * Authorisation is **not** here. Who may delete what is a different question
 * with different answers for a person and a plugin, and folding it in would
 * mean this module deciding both. The caller establishes the right to do it and
 * then asks for it to be done.
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
  /**
   * The message as it was before it went. Passed in rather than re-read: every
   * caller has already fetched it to decide whether they may delete it, and
   * reading it again would open a window where it is gone by the time we look
   * for its attachments.
   */
  message: MessageRecord;
  access: AllowedConversationAccess;
  /**
   * Injectable so a test can watch it happen. Not for production use — the
   * default is the only caller — but this is the step most likely to be lost
   * in a refactor and the least likely to be noticed when it is, so it is
   * worth being able to assert.
   */
  cleanUpAttachments?: (fileIds: string[]) => Promise<unknown>;
}

/**
 * Returns false when the row was not deleted — already gone, or the delete
 * failed. Nothing else runs in that case, because the message is still there
 * and telling everybody it is not would be worse than the failure.
 */
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
