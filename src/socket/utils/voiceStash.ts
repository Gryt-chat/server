import type { Clients } from "../../types";

/**
 * Voice state for someone whose signalling socket has gone, kept against the
 * user rather than the socket.
 *
 * `clientsInfo` is keyed by socket id, and voice membership is a property of
 * the person — so every reconnect threw it away and something had to put it
 * back. This used to be that something, under a 15 second timer, and only for
 * a `"transport close"` disconnect. Both limits were guesses, and both were
 * wrong in the same direction: a restart, a redeploy, a longer outage or any
 * other disconnect reason lost the state for good, leaving somebody in the
 * call, hearing everybody, publishing to the SFU, and shown to the room as
 * merely online (GRYT-611).
 *
 * There is no timer now. The SFU knows who is actually connected to it — the
 * server hands it the user id when it mints the join token — so the SFU is what
 * decides when this dies. `onSyncResponse` drops an entry the moment the SFU
 * stops reporting that user, and restores one the moment it reports somebody
 * the socket layer has lost track of.
 *
 * The stream id is the reason this is kept at all rather than rebuilt from the
 * sync alone. `sync_response` carries room ids and user ids and nothing else,
 * and the stream id is what every other client maps audio to a person by. Only
 * two things ever know it: the client that published it, and this.
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

/**
 * Forget somebody's voice state on purpose.
 *
 * Called when a person leaves voice deliberately, so the next sync cannot put
 * them back. Without it the SFU's view and the person's intent disagree for as
 * long as the media connection takes to actually close, and the sync would win
 * that argument.
 */
export function forgetStashedVoiceState(serverUserId: string): void {
  stashedVoiceState.delete(serverUserId);
}
