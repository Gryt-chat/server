/**
 * A DM reaches its members, a voice channel's text whoever is in it, anything
 * else everybody. Who may read it is `clientMayReceive`, at delivery.
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
