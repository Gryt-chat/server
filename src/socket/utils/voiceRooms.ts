/**
 * The two room names, in one place.
 *
 * There are two different identifiers and they are easy to confuse:
 *
 *   voiceRoomName  — the socket.io room, for broadcasting to participants
 *   sfuRoomId      — what the SFU knows the room as, for media operations
 *
 * Both were written out by hand at each call site, four times over, and the
 * hand-written copies had already drifted: server mute addressed the SFU as
 * `${serverUserId}:${streamID}` and a forced voice disconnect used
 * `${serverId}_${streamID}`, neither of which is a room the SFU has ever heard
 * of. Both calls went out, matched nothing, and failed silently — see GRYT-130.
 *
 * A wrong room id here does not throw. It just quietly does nothing, which is
 * the worst way for a moderation action to fail.
 */

/** The socket.io room the participants of a voice channel are joined to. */
export function voiceRoomName(serverId: string, channelId: string): string {
  return `voice:${serverId}:${channelId}`;
}

/** The room id the SFU knows, as registered when the channel is first joined. */
export function sfuRoomId(serverId: string, channelId: string): string {
  return `${serverId}_${channelId}`;
}
