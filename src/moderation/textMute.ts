import { effectiveModerationState, getUserByServerId } from "../db/sqlite/users";

/**
 * Not in `sessionGate`: a muted member is still a member, and refusing the
 * session would kick them. `effectiveModerationState` applies the expiry.
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

/** Named, and carrying the expiry, so the composer can say when it lifts. A
    message that vanishes with no reason reads as the app being broken. */
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
