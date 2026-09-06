/**
 * What somebody may put in "what I'm doing" (GRYT-929).
 *
 * Free text on a member row, shown to everybody on the server, and — once
 * plugins can set it — written by arbitrary JavaScript running in somebody's
 * client rather than by a person typing. Both of those make this a place worth
 * being narrow.
 *
 * Pure and on its own so the rules can be read and checked without a socket.
 */

/**
 * Long enough for "Listening to Bohemian Rhapsody — Queen", short enough that
 * it cannot push a member row into a paragraph. Measured against the longest
 * thing this is actually for: a track and an artist.
 */
export const MAX_ACTIVITY_LENGTH = 96;

/**
 * Anything that would make one line into several, or draw a shape.
 *
 * Newlines and tabs are the obvious ones. The rest are the invisible and
 * direction-changing characters that let a short string cover somebody else's
 * row or reverse the text around it — a member list is a column of names, and a
 * status is the one field in it that somebody else chooses the bytes of.
 */
const CONTROL_AND_TRICKS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Clean up what arrived, or null if nothing is left.
 *
 * Null is the "not set" state, and clearing goes through the same door as
 * setting: sending an empty string, or a string of spaces, is how somebody
 * takes their status down.
 *
 * **Truncated rather than refused.** A plugin sending a long track name is not
 * misbehaving, and a status that silently fails to appear is harder to explain
 * than one that is a bit shorter than expected.
 */
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
