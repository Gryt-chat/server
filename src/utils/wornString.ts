/**
 * Shape only. What the keys mean is not checked, so a cosmetic added after this
 * server was last updated still reaches everybody.
 */

/** Whole two-character fields, matching `decodeWorn` on the client. */
const SHAPE = /^(?:[a-z]{2}|--)+$/;

/** A build today writes 16 characters. Pinned to that, the release adding a
    sixth slot is refused by every server not yet updated. */
const MAX_LENGTH = 64;

/** `unchanged` and `clear` differ: most of these events are not about the
    avatar, so a missing field leaves the column alone. */
export type WornUpdate =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; worn: string }
  | { kind: "invalid" };

/** What `value` is asking for, as one of the four answers above. */
export function readWornUpdate(value: unknown): WornUpdate {
  if (value === undefined) return { kind: "unchanged" };
  if (value === null) return { kind: "clear" };
  if (typeof value !== "string") return { kind: "invalid" };

  const trimmed = value.trim().toLowerCase();
  // An empty string is a client finding that easier to send than a null. It
  // means the same thing.
  if (trimmed.length === 0) return { kind: "clear" };

  if (trimmed.length > MAX_LENGTH) return { kind: "invalid" };
  if (trimmed.length % 2 !== 0) return { kind: "invalid" };
  if (!SHAPE.test(trimmed)) return { kind: "invalid" };

  return { kind: "set", worn: trimmed };
}
