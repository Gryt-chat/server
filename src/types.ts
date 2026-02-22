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
    isServerMuted: boolean;
    isServerDeafened: boolean;
    status?: UserStatus;
    lastSeen?: Date;
    accessToken?: string; // JWT access token for this server
    latencyStats?: {
      estimatedOneWayMs: number | null;
      networkRttMs: number | null;
      jitterMs: number | null;
      codec: string | null;
      bitrateKbps: number | null;
    };
  };
}
