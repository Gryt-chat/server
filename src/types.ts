export type UserStatus = 'online' | 'in_voice' | 'afk' | 'offline';

export interface Clients {
  [id: string]: {
    grytUserId?: string; // Internal Gryt Auth user ID (never exposed to clients)
    serverUserId: string; // Secret server user ID (never exposed to clients)
    nickname: string;
    color: string;
    isMuted: boolean;
    isDeafened: boolean;
    streamID: string;
    hasJoinedChannel: boolean;
    voiceChannelId: string;
    isConnectedToVoice?: boolean;
    isAFK: boolean;
    cameraEnabled: boolean;
    cameraStreamID: string;
    screenShareEnabled: boolean;
    screenShareVideoStreamID: string;
    screenShareAudioStreamID: string;
    isServerMuted: boolean;
    isServerDeafened: boolean;
    /**
     * What this person says they are doing, in their own words (GRYT-929).
     *
     * **Here rather than in `users`, deliberately.** It belongs to the
     * connection the way `isAFK` does: a now-playing line has to stop being
     * true when somebody closes the app, and a stored one would still be
     * claiming they are listening to something a week later. The cost is that
     * it has to be re-sent after a reconnect, which the client already does for
     * voice state.
     *
     * Undefined means they have not set one. An empty string is not a state —
     * clearing it sets this back to undefined.
     */
    activity?: string;
    status?: UserStatus;
    lastSeen?: Date;
    accessToken?: string; // JWT access token for this server
    /**
     * What this member may do, cached for deciding who a broadcast reaches.
     *
     * Never used to authorise an action — see socket/utils/standing. Undefined
     * until the socket has joined.
     */
    permissions?: ReadonlySet<import("./constants/permissions").Permission>;
    latencyStats?: {
      estimatedOneWayMs: number | null;
      networkRttMs: number | null;
      jitterMs: number | null;
      codec: string | null;
      bitrateKbps: number | null;
    };
  };
}
