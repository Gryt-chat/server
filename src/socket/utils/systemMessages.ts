import consola from "consola";
import { Server } from "socket.io";

import { getServerConfig, insertMessage, listServerChannels } from "../../db";
import type { Clients } from "../../types";
import { recipientClientIds } from "./recipients";

export const SYSTEM_SENDER_ID = "system";

let cachedChannelId: string | null = null;
let channelCacheFetchedAt = 0;
const CHANNEL_CACHE_TTL_MS = 30_000;

async function getSystemChannelId(): Promise<string | null> {
  const now = Date.now();
  if (cachedChannelId && now - channelCacheFetchedAt < CHANNEL_CACHE_TTL_MS) {
    return cachedChannelId;
  }

  const cfg = await getServerConfig();
  if (cfg?.system_channel_id) {
    cachedChannelId = cfg.system_channel_id;
    channelCacheFetchedAt = now;
    return cachedChannelId;
  }

  const channels = await listServerChannels();
  const textChannel = channels.find((c) => c.type === "text");
  cachedChannelId = textChannel?.channel_id ?? null;
  channelCacheFetchedAt = now;
  return cachedChannelId;
}

export function invalidateSystemChannelCache(): void {
  cachedChannelId = null;
  channelCacheFetchedAt = 0;
}

export async function postSystemMessage(
  io: Server,
  clientsInfo: Clients,
  text: string,
): Promise<void> {
  try {
    const channelId = await getSystemChannelId();
    if (!channelId) {
      consola.warn("[systemMessage] No system channel found, skipping system message");
      return;
    }

    const msg = await insertMessage({
      conversation_id: channelId,
      sender_server_id: SYSTEM_SENDER_ID,
      text,
      attachments: null,
      reactions: null,
    });

    const enriched = {
      ...msg,
      sender_nickname: "System",
      sender_avatar_file_id: undefined,
    };

    // The same audience the channel's own messages reach, or the join line
    // lands in front of a socket that never joined or cannot see the channel.
    const recipients = await recipientClientIds(channelId, { allowed: true, kind: "channel" }, clientsInfo, null);
    for (const cid of recipients) {
      io.sockets.sockets.get(cid)?.emit("chat:new", enriched);
    }
  } catch (e) {
    consola.error("[systemMessage] Failed to post system message:", e);
  }
}

/**
 * A line in a group, sent by "system": who added whom (GRYT-1753). It goes to everybody
 * in the group, the one just added included, as stored history rather than a toast.
 */
export async function postConversationSystemMessage(
  io: Server,
  clientsInfo: Clients,
  conversationId: string,
  memberIds: string[],
  text: string,
): Promise<void> {
  try {
    const msg = await insertMessage({
      conversation_id: conversationId,
      sender_server_id: SYSTEM_SENDER_ID,
      text,
      attachments: null,
      reactions: null,
    });
    const enriched = { ...msg, sender_nickname: "System", sender_avatar_file_id: undefined };
    const recipients = await recipientClientIds(conversationId, { allowed: true, kind: "dm", memberIds, group: true }, clientsInfo, null);
    for (const cid of recipients) {
      io.sockets.sockets.get(cid)?.emit("chat:new", enriched);
    }
  } catch (e) {
    consola.error("[systemMessage] Failed to post a conversation system message:", e);
  }
}

/** Who added whom to a group. Mentions, so each client draws the names it knows them by. */
export function formatAddedMessage(
  by: { nickname: string; serverUserId: string },
  added: { nickname: string; serverUserId: string },
): string {
  return `[@${by.nickname}](mention:${by.serverUserId}) added [@${added.nickname}](mention:${added.serverUserId})`;
}

export function formatJoinMessage(nickname: string, serverUserId: string): string {
  return `[@${nickname}](mention:${serverUserId}) joined the server`;
}

/** What an app from before MLS shows for an MLS message (GRYT-1508). Plain text there
    would carry that app's "Not encrypted" mark, so it goes out as a system line. */
export function formatMlsPlaceholder(nickname: string, serverUserId: string): string {
  return `[@${nickname}](mention:${serverUserId}) sent an end-to-end encrypted message. Update Gryt to read it.`;
}

export function formatLeaveMessage(nickname: string, serverUserId: string): string {
  return `[@${nickname}](mention:${serverUserId}) left the server`;
}
