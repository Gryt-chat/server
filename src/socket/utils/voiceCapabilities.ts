import consola from "consola";
import type { Server } from "socket.io";

import { mayInChannel } from "../../services/channelPermissions";
import { CAP_SHARE_SCREEN, CAP_SHARE_VIDEO, CAP_SPEAK, CAP_VIDEO_CHECKED } from "../../sfu/clientToken";
import type { Clients } from "../../types";
import { syncAllClients } from "./clients";

/** What a member's SFU token carries in one channel. The token and every later
    push come from here, so the two cannot disagree. */
export async function voiceCapabilities(
  channelId: string,
  serverUserId: string | undefined,
  grytUserId?: string,
): Promise<string[]> {
  const may = (permission: "speak" | "share_video" | "share_screen") =>
    mayInChannel(channelId, serverUserId, permission, grytUserId);
  const capabilities: string[] = (await may("speak")) ? [CAP_SPEAK] : [];
  // A client can skip announcing a camera or share. It cannot skip the SFU.
  capabilities.push(CAP_VIDEO_CHECKED);
  if (await may("share_video")) capabilities.push(CAP_SHARE_VIDEO);
  if (await may("share_screen")) capabilities.push(CAP_SHARE_SCREEN);
  return capabilities;
}

/** The two things this needs from the SFU client. */
export interface CapabilitySfu {
  getActiveUsers(): Map<string, { roomId: string; userId: string }>;
  setUserCapabilities(roomId: string, userId: string, capabilities: readonly string[]): Promise<void>;
}

interface Refs {
  io: Server;
  clientsInfo: Clients;
  serverId: string;
  sfu: CapabilitySfu;
}

/** `voice:doctor:request` names its room `doctor:<user>`. */
const DOCTOR_ROOM_PREFIX = "doctor:";

let refs: Refs | null = null;
// What the SFU was last told, by `${sfuRoomId}|${serverUserId}`, so a broadcast
// that changed nothing for someone sends them nothing.
const lastSent = new Map<string, string>();
// One push at a time. Two overlapping ones could land old-then-new at the SFU.
let queue: Promise<void> = Promise.resolve();

export function setVoiceCapabilityRefs(next: Refs | null): void {
  refs = next;
  lastSent.clear();
}

function enqueue(work: (r: Refs) => Promise<void>): Promise<void> {
  const r = refs;
  if (!r) return Promise.resolve();
  queue = queue
    .then(() => work(r))
    .catch((e) => consola.warn("[Voice:Capabilities] push failed", e));
  return queue;
}

/** After anything that can change a channel permission or a role: tell the SFU
    about every member in a call whose capabilities moved (GRYT-1426). */
export function pushVoiceCapabilities(): Promise<void> {
  return enqueue(async (r) => {
    for (const { roomId, userId } of r.sfu.getActiveUsers().values()) {
      await pushOne(r, roomId, userId, false);
    }
  });
}

/** On peer_joined, unconditionally. A change made between minting the token and
    the peer arriving was sent to nobody, and this is its second chance. */
export function pushVoiceCapabilitiesFor(roomId: string, userId: string): Promise<void> {
  return enqueue((r) => pushOne(r, roomId, userId, true));
}

export function forgetVoiceCapabilities(userId: string): void {
  for (const key of lastSent.keys()) {
    if (key.endsWith(`|${userId}`)) lastSent.delete(key);
  }
}

async function pushOne(r: Refs, roomId: string, userId: string, always: boolean): Promise<void> {
  const prefix = `${r.serverId}_`;
  if (!roomId.startsWith(prefix)) return;
  const channelId = roomId.slice(prefix.length);
  // The doctor's room of one always speaks, and answers to no channel.
  if (channelId.startsWith(DOCTOR_ROOM_PREFIX)) return;
  const member = Object.values(r.clientsInfo).find((ci) => ci.serverUserId === userId);
  const capabilities = await voiceCapabilities(channelId, userId, member?.grytUserId);

  const key = `${roomId}|${userId}`;
  const joined = capabilities.join(",");
  if (!always && lastSent.get(key) === joined) return;
  lastSent.set(key, joined);

  await r.sfu.setUserCapabilities(roomId, userId, capabilities);
  if (turnOffWhatWasTaken(r.clientsInfo, userId, channelId, capabilities)) {
    syncAllClients(r.io, r.clientsInfo);
  }
}

/** The SFU has already stopped forwarding it. This makes the member list say so,
    and records a member without speak as muted, as `voice:state:update` would. */
export function turnOffWhatWasTaken(
  clientsInfo: Clients,
  userId: string,
  channelId: string,
  capabilities: readonly string[],
): boolean {
  let changed = false;
  for (const ci of Object.values(clientsInfo)) {
    if (ci.serverUserId !== userId || !ci.hasJoinedChannel || ci.voiceChannelId !== channelId) continue;
    if (!capabilities.includes(CAP_SHARE_VIDEO) && ci.cameraEnabled) {
      ci.cameraEnabled = false;
      ci.cameraStreamID = "";
      changed = true;
    }
    if (!capabilities.includes(CAP_SHARE_SCREEN) && ci.screenShareEnabled) {
      ci.screenShareEnabled = false;
      ci.screenShareVideoStreamID = "";
      ci.screenShareAudioStreamID = "";
      changed = true;
    }
    if (!capabilities.includes(CAP_SPEAK) && !ci.isMuted) {
      ci.isMuted = true;
      changed = true;
    }
  }
  return changed;
}
