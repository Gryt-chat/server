/**
 * Free text on a member row that everybody reads, and that a plugin can write.
 * Pure, so the rules can be checked without a socket.
 */

/** Long enough for a track and an artist, short enough that it cannot push a
    member row into a paragraph. */
export const MAX_ACTIVITY_LENGTH = 96;

/** Newlines and tabs, plus the invisible and direction-changing characters that
    let a short string cover somebody else's row. */
const CONTROL_AND_TRICKS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Null is the not-set state, and an empty string is how somebody clears one.
    Truncated rather than refused: a long track name is not misbehaviour. */
export function normaliseActivity(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const cleaned = value
    .replace(CONTROL_AND_TRICKS, " ")
    // Collapse afterwards, so removing a zero-width character between two words
    // does not glue them together and so a run of spaces is one space.
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;

  if (cleaned.length <= MAX_ACTIVITY_LENGTH) return cleaned;

  // Cut to the cap including the ellipsis, so the field never exceeds what the
  // row was measured for.
  return `${cleaned.slice(0, MAX_ACTIVITY_LENGTH - 1).trimEnd()}…`;
}
