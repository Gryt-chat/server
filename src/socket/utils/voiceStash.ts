import type { Server, Socket } from "socket.io";

import type { Clients } from "../../types";
import { voiceRoomName } from "./voiceRooms";

/**
 * Against the user, not the socket, and with no timer: the SFU decides when an
 * entry dies. The stream id is why a sync cannot rebuild this.
 */
export interface StashedVoiceState {
  voiceChannelId: string;
  streamID: string;
  nickname: string;
  screenShareEnabled: boolean;
  screenShareVideoStreamID: string;
  screenShareAudioStreamID: string;
  cameraEnabled: boolean;
  cameraStreamID: string;
  isMuted: boolean;
  isDeafened: boolean;
  /** When the socket went. A socket that connected later may be the same app back. */
  heldAt: number;
}

export const stashedVoiceState = new Map<string, StashedVoiceState>();

/** Keep signaling recovery explicit; the SFU tracker's connectedAt can be unrelated and old. */
export const VOICE_RECOVERY_GRACE_MS = 45_000;
const voiceRecoveryGraceUntil = new Map<string, number>();

/** Never shortens one already running, so a short wait inside a recovery keeps the long one. */
export function beginVoiceRecoveryGrace(
  serverUserId: string,
  now = Date.now(),
  durationMs = VOICE_RECOVERY_GRACE_MS,
): void {
  if (!serverUserId) return;
  const until = Math.max(voiceRecoveryGraceUntil.get(serverUserId) ?? 0, now + durationMs);
  voiceRecoveryGraceUntil.set(serverUserId, until);
}

export function clearVoiceRecoveryGrace(serverUserId: string): void {
  if (!serverUserId) return;
  voiceRecoveryGraceUntil.delete(serverUserId);
}

export function isVoiceRecoveryGraceActive(
  serverUserId: string,
  now = Date.now(),
): boolean {
  if (!serverUserId) return false;

  const until = voiceRecoveryGraceUntil.get(serverUserId);
  if (until === undefined) return false;

  if (until <= now) {
    voiceRecoveryGraceUntil.delete(serverUserId);
    return false;
  }

  return true;
}

/** Everything this socket had in voice, as a stash entry. */
export function voiceStateOf(ci: Clients[string], now = Date.now()): StashedVoiceState {
  return {
    voiceChannelId: ci.voiceChannelId || "",
    streamID: ci.streamID || "",
    nickname: ci.nickname,
    screenShareEnabled: ci.screenShareEnabled,
    screenShareVideoStreamID: ci.screenShareVideoStreamID,
    screenShareAudioStreamID: ci.screenShareAudioStreamID,
    cameraEnabled: ci.cameraEnabled,
    cameraStreamID: ci.cameraStreamID,
    isMuted: ci.isMuted,
    isDeafened: ci.isDeafened,
    heldAt: now,
  };
}

/** Puts a held call back on a socket. No `voice:peer:joined`: nobody was told
    this person left, so the join chime would be a chime on a recovery. */
export function applyVoiceState(
  socket: Socket,
  ci: Clients[string],
  state: StashedVoiceState,
  channelId: string,
  serverId: string,
): void {
  ci.hasJoinedChannel = true;
  ci.voiceChannelId = channelId;
  ci.streamID = state.streamID;
  ci.isConnectedToVoice = true;
  ci.screenShareEnabled = state.screenShareEnabled;
  ci.screenShareVideoStreamID = state.screenShareVideoStreamID;
  ci.screenShareAudioStreamID = state.screenShareAudioStreamID;
  ci.cameraEnabled = state.cameraEnabled;
  ci.cameraStreamID = state.cameraStreamID;
  ci.isMuted = state.isMuted;
  ci.isDeafened = state.isDeafened;

  const roomName = channelId ? voiceRoomName(serverId, channelId) : "";
  if (roomName) socket.join(roomName);

  socket.emit("voice:state:restored", {
    channelId,
    streamID: state.streamID,
  });
}

/** The newest socket of this user, not in a call, that connected after `heldAt`.
    One connected before is another device, which the call has nothing to do with. */
export function recoveringSocketId(
  io: Server,
  clientsInfo: Clients,
  serverUserId: string,
  heldAt: number,
): string | null {
  let newest: string | null = null;
  for (const [sid, ci] of Object.entries(clientsInfo)) {
    if (ci.serverUserId !== serverUserId || ci.hasJoinedChannel) continue;
    const connectedAt = io.sockets.sockets.get(sid)?.handshake.issued ?? 0;
    if (connectedAt >= heldAt) newest = sid;
  }
  return newest;
}

/** So the next sync cannot put back somebody who left deliberately, while the
    media connection is still closing. */
export function forgetStashedVoiceState(serverUserId: string): void {
  stashedVoiceState.delete(serverUserId);
  clearVoiceRecoveryGrace(serverUserId);
}
