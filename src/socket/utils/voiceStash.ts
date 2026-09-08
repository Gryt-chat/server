import type { Clients } from "../../types";

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
}

export const stashedVoiceState = new Map<string, StashedVoiceState>();

/** Everything this socket had in voice, as a stash entry. */
export function voiceStateOf(ci: Clients[string]): StashedVoiceState {
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
  };
}

/** So the next sync cannot put back somebody who left deliberately, while the
    media connection is still closing. */
export function forgetStashedVoiceState(serverUserId: string): void {
  stashedVoiceState.delete(serverUserId);
}
