/** Someone in a bridged Discord voice channel, shown in the Gryt channel as a voice participant of their own. */
export interface DiscordVoiceParticipant {
  /** `discord:<id>`, the user id the SFU names their audio by. */
  serverUserId: string;
  name: string;
  avatar: string;
  channelId: string;
}

const participants = new Map<string, DiscordVoiceParticipant>();

export function setDiscordVoiceParticipant(p: DiscordVoiceParticipant): void {
  participants.set(p.serverUserId, p);
}

export function removeDiscordVoiceParticipant(serverUserId: string): boolean {
  return participants.delete(serverUserId);
}

export function discordVoiceParticipants(): DiscordVoiceParticipant[] {
  return [...participants.values()];
}
