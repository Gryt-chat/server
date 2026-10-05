import consola from "consola";

import { getMessageById, getUserByServerId, listMessagesWithFile } from "../db";
import { pluginRefs } from "../plugins/refs";
import { enrichAttachments } from "../socket/handlers/chat";
import { recipientClientIds } from "../socket/utils/recipients";
import { resolveConversationAccess } from "../socket/utils/conversationAccess";
import { settleQuarantine } from "./quarantineUpload";

/* A chat attachment shows a loader until the worker has written it out. Once it has, or has
   refused it, each message carrying it is sent again to the people who can read it (GRYT-1669). */
export async function settleChatAttachment(fileId: string): Promise<void> {
  try {
    if ((await settleQuarantine(fileId)) === "timeout") return;
    // The socket layer's refs, which carry the SFU client that working out a channel's readers needs.
    const refs = pluginRefs();
    if (!refs) return;
    for (const { conversation_id, message_id } of await listMessagesWithFile(fileId)) {
      const message = await getMessageById(conversation_id, message_id);
      if (!message) continue;
      const access = await resolveConversationAccess(conversation_id, message.sender_server_id);
      if (!access.allowed) continue;
      const sender = await getUserByServerId(message.sender_server_id);
      const [enriched] = await enrichAttachments([{ ...message, sender_nickname: sender?.nickname ?? message.sender_nickname }]);
      if (!enriched?.enriched_attachments) continue;
      const payload = { conversation_id, message_id, enriched_attachments: enriched.enriched_attachments };
      for (const cid of await recipientClientIds(conversation_id, access, refs.clientsInfo, refs.sfuClient)) {
        refs.io.sockets.sockets.get(cid)?.emit("chat:attachments", payload);
      }
    }
  } catch (err) {
    consola.warn(`[uploads] Could not settle attachment ${fileId}`, err);
  }
}
