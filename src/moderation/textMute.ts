import { effectiveModerationState, getUserByServerId } from "../db/sqlite/users";

/**
 * Whether a member is muted, for the paths that put text in a channel.
 *
 * A mute stopped voice and nothing else. `server:mute` has written
 * `server_mute_expires_at` since timeouts landed, the member list has drawn the
 * flag, and the client has shown when it lifts — while `chat:send` never read
 * any of it. So a moderator muted somebody who was spamming, the room watched
 * them show as muted, and they carried on posting.
 *
 * Read here rather than in `sessionGate`, which is the other live-state check
 * on this path. That one decides whether a session may exist at all, and a
 * muted member is still a member: they read, they join voice and are silent
 * there, they are simply not talking. Refusing the session would kick them.
 *
 * The expiry is applied by `effectiveModerationState`, so a lapsed timeout is
 * not a mute even before anything clears the row.
 */
export type TextMute = { muted: false } | { muted: true; until: Date | null };

const NOT_MUTED: TextMute = { muted: false };

export async function textMuteFor(serverUserId: string): Promise<TextMute> {
  const user = await getUserByServerId(serverUserId);
  if (!user) return NOT_MUTED;

  const { isServerMuted } = effectiveModerationState(user);
  if (!isServerMuted) return NOT_MUTED;

  return { muted: true, until: user.server_mute_expires_at ?? null };
}

/**
 * What to tell somebody who tried to talk while muted.
 *
 * Named, and carrying the expiry, so the composer can say "you are muted until
 * 14:20" rather than failing silently — a message that vanishes with no reason
 * reads as the app being broken, which is what the client does with an error it
 * has no case for.
 */
export function textMuteError(mute: { until: Date | null }): {
  error: "muted";
  expiresAt: string | null;
  message: string;
} {
  return {
    error: "muted",
    expiresAt: mute.until ? mute.until.toISOString() : null,
    message: mute.until
      ? `You are muted on this server until ${mute.until.toISOString()}.`
      : "You are muted on this server.",
  };
}
