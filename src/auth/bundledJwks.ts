import type { JWK } from "jose";

/**
 * The identity CA's public keys, shipped rather than fetched (GRYT-721).
 *
 * Fetching the JWKS put every Gryt server that ever admitted an account holder
 * in the identity service's log, with its address — and a certificate request
 * from the same address said who runs that server. Gryt is meant to be a thing
 * you can run without telling anybody.
 *
 * Shipping a public key is what a root store is, and pinning makes verification
 * stronger: a server that never asks cannot be handed a different answer.
 *
 * Rotation still works. `identity.ts` falls back to the remote set only when
 * the bundled one has no key matching the certificate's `kid`, never when a
 * matching key is present and the signature fails.
 *
 * **Updating this:** `curl https://id.gryt.chat/.well-known/jwks.json`, and keep
 * the retiring key alongside the new one for 30 days, the certificate lifetime,
 * or every certificate it signed falls through to a fetch.
 *
 * Only issuers listed here are bundled; anybody else's CA goes to the network.
 */
export const BUNDLED_IDENTITY_JWKS: Record<string, { keys: JWK[] }> = {
  "https://id.gryt.chat": {
    keys: [
      {
        kty: "EC",
        x: "6Gr3PcpdiUbD0UQbB4xXlJ0DaKYUTelOs7tTEiDe0a8",
        y: "Jfh6Qe_aPLv0YozJgKfgeQ9NQw5UQ7sd9RdQ6fz3Uis",
        crv: "P-256",
        alg: "ES256",
        use: "sig",
        kid: "6a73d78f6211120b",
      },
    ],
  },
};
