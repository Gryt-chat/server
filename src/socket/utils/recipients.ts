/**
 * Which connected clients should be told about something in a conversation
 * (GRYT-936).
 *
 * Lived as a closure inside `registerChatHandlers`, which was the right place
 * while every answer was being sent in response to somebody's socket event.
 * Deleting a message is no longer only that — a plugin can do it, with no
 * socket and no member behind it — and a second copy of this is a second
 * answer to "who can see this channel", which is not a question that should
 * have two.
 *
 * Three cases, in the order they are decided:
 *
 * - a direct message goes to its members and nobody else
 * - a voice channel's text goes to the people currently *in* that voice
 *   channel, because that is what makes it the channel's chat rather than a
 *   room anybody can read
 * - anything else goes to everybody connected
 *
 * The last one looks broad and is not the whole story: what a member may see is
 * decided when the message is delivered, in `clientMayReceive`. This answers
 * where a conversation reaches, not who is allowed to read it.
 */

import type { SFUClient } from "../../sfu/client";
import type { Clients } from "../../types";
import type { AllowedConversationAccess } from "./conversationAccess";

/** Whether anybody is in this conversation as a voice room right now. */
export function isConversationAVoiceChannel(
  conversationId: string,
  sfuClient: SFUClient | null,
): boolean {
  if (!sfuClient?.isConnected()) return false;
  const activeUsers = sfuClient.getActiveUsers();
  for (const [, conn] of activeUsers) {
    if (conn.roomId === conversationId) return true;
  }
  return false;
}

export function isUserConnectedToSpecificVoiceChannel(
  serverUserId: string,
  conversationId: string,
  sfuClient: SFUClient | null,
): boolean {
  if (!sfuClient?.isConnected()) return false;
  const userConnection = sfuClient.getActiveUsers().get(serverUserId);
  return userConnection?.roomId === conversationId;
}

export function recipientClientIds(
  conversationId: string,
  access: AllowedConversationAccess,
  clientsInfo: Clients,
  sfuClient: SFUClient | null,
): string[] {
  const members = access.kind === "dm" ? new Set(access.memberIds) : null;
  const voice = isConversationAVoiceChannel(conversationId, sfuClient);

  return Object.entries(clientsInfo)
    .filter(([, ci]) => {
      if (members) return members.has(ci.serverUserId);
      if (voice) return isUserConnectedToSpecificVoiceChannel(ci.serverUserId, conversationId, sfuClient);
      return true;
    })
    .map(([cid]) => cid);
}
