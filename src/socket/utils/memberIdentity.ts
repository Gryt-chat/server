import { createHmac } from "crypto";

import { identityTierOf, type IdentityTier } from "../../auth/identity";

/**
 * The identity details a member list carries, so somebody being impersonated by
 * nickname can be told apart from the person doing it.
 *
 * Nicknames have never been unique — no constraint on the column, and the name
 * a client sends wins over the one in its certificate — so this is a hole that
 * predates identity tiers. Local identity makes it cheaper to walk through, not
 * newly possible.
 */
export interface MemberIdentity {
  identityTier: IdentityTier;
  identityFingerprint: string;
}

/**
 * A stable, per-server marker for an identity.
 *
 * **Not the `gryt_user_id`.** For an account that id is a Keycloak `sub`, which
 * is the same on every Gryt server there is — putting it in a member list would
 * let anyone who can see two servers' member lists work out that the same
 * person is in both. Nothing about telling users apart *here* requires an id
 * that means anything *there*.
 *
 * HMAC rather than a plain hash, keyed on `JWT_SECRET`, and that choice does
 * real work: a local identity is a keypair its holder mints, so with an
 * unkeyed hash somebody could generate keypairs until their fingerprint
 * matched the prefix of the person they wanted to be mistaken for. Six hex
 * characters is 24 bits, which is minutes of work. Keying it means the
 * fingerprint cannot be computed off the server at all, so there is nothing to
 * grind against.
 *
 * `JWT_SECRET` is reused rather than adding a stored salt because it is already
 * per-server, already persisted and already required. If it changes every
 * fingerprint changes, which is acceptable — that also signs everybody out.
 */
export function memberIdentity(grytUserId: string): MemberIdentity {
  const secret = process.env.JWT_SECRET || "";

  return {
    identityTier: identityTierOf(grytUserId),
    identityFingerprint: createHmac("sha256", secret)
      .update(grytUserId)
      .digest("base64url"),
  };
}
