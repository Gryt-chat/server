import { createHmac } from "crypto";

import { identityTierOf, type IdentityTier } from "../../auth/identity";

/** Nicknames have never been unique: no constraint on the column, and the name
    a client sends wins over the one in its certificate. */
export interface MemberIdentity {
  identityTier: IdentityTier;
  identityFingerprint: string;
}

/**
 * HMAC keyed on `JWT_SECRET`, not a hash: a local identity is a keypair anybody
 * can mint, so six unkeyed hex characters is minutes of grinding.
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
