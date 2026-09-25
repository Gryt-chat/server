import consola from "consola";
import type { Server } from "socket.io";

import { effectiveModerationState, getUserByServerId } from "../db";
import type { SFUClient } from "../sfu/client";
import { broadcastMemberList, syncAllClients } from "../socket/utils/clients";
import { sfuRoomId } from "../socket/utils/voiceRooms";
import type { Clients } from "../types";

/** The room is `${serverId}_${voiceChannelId}` and the user is the server user
    id. Both were once wrong, so only a cooperating client was ever muted. */
export function pushSfuAudioState(
  sfuClient: SFUClient | null,
  serverId: string,
  ci: Clients[string],
): void {
  if (!sfuClient || !ci.hasJoinedChannel || !ci.voiceChannelId) return;
  const roomId = sfuRoomId(serverId, ci.voiceChannelId);
  sfuClient
    .updateUserAudioState(
      roomId,
      ci.serverUserId,
      ci.isMuted || ci.isServerMuted,
      ci.isDeafened || ci.isServerDeafened,
    )
    .catch((e) => consola.error("Failed to update SFU audio state:", e));
}

export interface MuteAnnouncement {
  io: Server;
  clientsInfo: Clients;
  sfuClient: SFUClient | null;
  serverId: string;
  serverUserId: string;
  muted: boolean;
  until: Date | null;
  /** Set when nobody pressed a button, so the client can say what did. */
  reason?: "spam";
}

/* One per member. Replaced by a newer mute and dropped by an unmute, so a lapsed
   timer never lifts a mute somebody set since. */
const lifts = new Map<string, ReturnType<typeof setTimeout>>();

/** Tells the member's connections and the SFU. The row is the caller's to write
    first; this is its cache, and without the write a reconnect clears it. */
export function announceMute(a: MuteAnnouncement): void {
  for (const [sid, s] of a.io.sockets.sockets) {
    const ci = a.clientsInfo[sid];
    if (ci?.serverUserId !== a.serverUserId) continue;
    ci.isServerMuted = a.muted;
    s.emit("server:muted", {
      muted: a.muted,
      expiresAt: a.until?.toISOString() ?? null,
      ...(a.reason ? { reason: a.reason } : {}),
    });
    pushSfuAudioState(a.sfuClient, a.serverId, ci);
  }
  scheduleLift(a);
}

/* A timeout lapses in the row by itself, but the socket flag and the SFU only
   learn on a reconnect. This tells them when it ends. */
function scheduleLift(a: MuteAnnouncement): void {
  const existing = lifts.get(a.serverUserId);
  if (existing) clearTimeout(existing);
  lifts.delete(a.serverUserId);
  if (!a.muted || !a.until) return;

  const wait = a.until.getTime() - Date.now();
  if (wait > 2_147_483_647) return;
  const timer = setTimeout(() => {
    lifts.delete(a.serverUserId);
    void liftIfLapsed(a).catch((e) => consola.warn("lifting a timeout failed", a.serverUserId, e));
  }, Math.max(0, wait) + 250);
  timer.unref();
  lifts.set(a.serverUserId, timer);
}

async function liftIfLapsed(a: MuteAnnouncement): Promise<void> {
  const user = await getUserByServerId(a.serverUserId);
  if (!user || effectiveModerationState(user).isServerMuted) return;
  announceMute({ ...a, muted: false, until: null, reason: undefined });
  syncAllClients(a.io, a.clientsInfo);
  broadcastMemberList(a.io, a.clientsInfo, a.serverId);
}
