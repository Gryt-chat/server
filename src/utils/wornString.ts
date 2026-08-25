/**
 * The shape of a worn string, checked without knowing what it draws.
 *
 * A worn string is what somebody's owl is wearing — `wearing.ts` in `@gryt/owl`
 * writes it and reads it back. It arrives from a client and is stored beside
 * the nickname, so it is stranger input and gets checked before it reaches a
 * row.
 *
 * What is deliberately not checked is whether the keys mean anything.
 * Resolving `ah` to a particular hat needs the accessory registry, which means
 * a `@gryt/owl` dependency on the server, which means three copies of the
 * package that have to agree instead of two — on a box that is upgraded on a
 * different schedule from either app. GRYT-585 exists because keeping two in
 * step was already hard enough to need a scheduled job.
 *
 * The consequence is the useful part: a cosmetic drawn after this server was
 * last updated still reaches everybody, because the string passes through
 * untouched and the clients decide what of it they can draw. A server that
 * validated content would refuse looks from clients newer than itself, which is
 * exactly the wrong way round for a self-hosted server that may sit at one
 * version for a year.
 */

/**
 * Whole two-character fields, each `a-z` or `--`.
 *
 * The same expression `decodeWorn` applies on the client, for the same reason:
 * anything else is a bug in whatever wrote it rather than a look that has moved
 * on.
 */
const SHAPE = /^(?:[a-z]{2}|--)+$/;

/**
 * Generous, and not a guess at the current width.
 *
 * A build today writes 16 characters — five accessory slots plus palette,
 * scheme and ears. Pinning the cap to that would mean the release that adds a
 * sixth slot is refused by every server not yet updated, which is the failure
 * the length-tolerant decoder was written to avoid, reintroduced one layer
 * down. 64 leaves room for sixteen more fields and is still small enough that
 * the column costs nothing.
 */
const MAX_LENGTH = 64;

/**
 * What a `profile:update` is asking to do to the stored look.
 *
 * `unchanged` and `clear` are different answers and conflating them loses the
 * feature. Most `profile:update` events are not about the avatar at all — the
 * client sends one when a nickname is saved and when a profile is synced across
 * servers — so a missing field has to leave the column alone. An explicit
 * `null` is somebody going back to an uploaded picture, and that has to be
 * written.
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
