/**
 * A DM reaches its members, a voice channel's text whoever is in it, anything
 * else whoever may read the channel. An unidentified socket is nobody.
 */

import type { SFUClient } from "../../sfu/client";
import type { Clients } from "../../types";
import { scopedChannelIds, visibleChannelIds } from "../../services/channelPermissions";
import { clientMayReceive, socketIsIdentified } from "./standing";
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

/** Who a message here may reach. Delivery, not authorisation, but a socket that
    never proved who it is, or cannot read the channel, is not a recipient. */
export async function recipientClientIds(
  conversationId: string,
  access: AllowedConversationAccess,
  clientsInfo: Clients,
  sfuClient: SFUClient | null,
): Promise<string[]> {
  if (access.kind === "dm") {
    // Member ids are real server ids, so a temp socket never matches; the
    // identified check says so rather than leaving it to that coincidence.
    const members = new Set(access.memberIds);
    return Object.entries(clientsInfo)
      .filter(([cid, ci]) => socketIsIdentified(clientsInfo, cid) && members.has(ci.serverUserId))
      .map(([cid]) => cid);
  }

  const voice = isConversationAVoiceChannel(conversationId, sfuClient);

  // Only a scoped channel needs the per-recipient visibility read; an ungated
  // one is settled by the cached read_messages standing alone.
  const gated = (await scopedChannelIds()).has(conversationId);

  // One visibility read per person, not per socket: a member with two devices
  // gets the same answer for both.
  const viewByUser = new Map<string, boolean>();
  const mayView = async (serverUserId: string, grytUserId?: string): Promise<boolean> => {
    const cached = viewByUser.get(serverUserId);
    if (cached !== undefined) return cached;
    const ok = (await visibleChannelIds(serverUserId, grytUserId)).has(conversationId);
    viewByUser.set(serverUserId, ok);
    return ok;
  };

  const recipients: string[] = [];
  for (const [cid, ci] of Object.entries(clientsInfo)) {
    // False for an unidentified or temp socket, and for anyone whose standing
    // was cleared: the check the live path never made.
    if (!clientMayReceive(clientsInfo, cid, "read_messages")) continue;
    if (voice && !isUserConnectedToSpecificVoiceChannel(ci.serverUserId, conversationId, sfuClient)) continue;
    if (gated && !(await mayView(ci.serverUserId, ci.grytUserId))) continue;
    recipients.push(cid);
  }
  return recipients;
}
