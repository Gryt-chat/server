import consola from "consola";
import { Server } from "socket.io";

import { insertMessage, listServerChannels } from "../../db/scylla";
import type { Clients } from "../../types";

const SYSTEM_SENDER_ID = "system";

let cachedTextChannelId: string | null = null;
let channelCacheFetchedAt = 0;
const CHANNEL_CACHE_TTL_MS = 30_000;

async function getFirstTextChannelId(): Promise<string | null> {
  const now = Date.now();
  if (cachedTextChannelId && now - channelCacheFetchedAt < CHANNEL_CACHE_TTL_MS) {
    return cachedTextChannelId;
  }
  const channels = await listServerChannels();
  const textChannel = channels.find((c) => c.type === "text");
  cachedTextChannelId = textChannel?.channel_id ?? null;
  channelCacheFetchedAt = now;
  return cachedTextChannelId;
}

export async function postSystemMessage(
  io: Server,
  clientsInfo: Clients,
  text: string,
): Promise<void> {
  try {
    const channelId = await getFirstTextChannelId();
    if (!channelId) {
      consola.warn("[systemMessage] No text channel found, skipping system message");
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

    for (const [cid] of Object.entries(clientsInfo)) {
      io.sockets.sockets.get(cid)?.emit("chat:new", enriched);
    }
  } catch (e) {
    consola.error("[systemMessage] Failed to post system message:", e);
  }
}

export function formatJoinMessage(nickname: string, serverUserId: string): string {
  return `[@${nickname}](mention:${serverUserId}) joined the server`;
}

export function formatLeaveMessage(nickname: string, serverUserId: string): string {
  return `[@${nickname}](mention:${serverUserId}) left the server`;
}
