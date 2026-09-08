/**
 * `voiceRoomName` is the socket.io room, `sfuRoomId` what the SFU knows it as.
 * A wrong id does not throw; it quietly does nothing.
 */

/** The socket.io room the participants of a voice channel are joined to. */
export function voiceRoomName(serverId: string, channelId: string): string {
  return `voice:${serverId}:${channelId}`;
}

/** The room id the SFU knows, as registered when the channel is first joined. */
export function sfuRoomId(serverId: string, channelId: string): string {
  return `${serverId}_${channelId}`;
}
