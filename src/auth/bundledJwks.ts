import type { JWK } from "jose";

/**
 * Shipped, not fetched, which put every server in the CA's log with its address.
 * Update from `id.gryt.chat/.well-known/jwks.json`, keeping the old key 30 days.
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
