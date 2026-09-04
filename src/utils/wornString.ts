/**
 * The shape of a worn string, checked without knowing what it draws.
 *
 * **What the keys mean is deliberately not checked.** Resolving `ah` to a
 * particular hat needs `@gryt/owl` on the server, which is a third copy to keep
 * in step on a box upgraded on its own schedule. The useful consequence is that
 * a cosmetic added after this server was last updated still reaches everybody
 * — a server that validated content would refuse looks from newer clients.
 */

/** Whole two-character fields, matching `decodeWorn` on the client. */
const SHAPE = /^(?:[a-z]{2}|--)+$/;

/**
 * Generous on purpose. A build today writes 16 characters; pinning the cap to
 * that means the release adding a sixth accessory slot is refused by every
 * server not yet updated.
 */
const MAX_LENGTH = 64;

/**
 * What a `profile:update` asks of the stored look. `unchanged` and `clear` are
 * different answers: most of these events are not about the avatar at all, so a
 * missing field leaves the column alone, while an explicit null is written.
 */
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
  // An empty string is somebody clearing their look through a client that finds
  // that easier to send than a null. It means the same thing, so it is taken to
  // mean it rather than refused on a technicality.
  if (trimmed.length === 0) return { kind: "clear" };

  if (trimmed.length > MAX_LENGTH) return { kind: "invalid" };
  if (trimmed.length % 2 !== 0) return { kind: "invalid" };
  if (!SHAPE.test(trimmed)) return { kind: "invalid" };

  return { kind: "set", worn: trimmed };
}
