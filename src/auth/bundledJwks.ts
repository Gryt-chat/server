import type { JWK } from "jose";

/**
 * Shipped rather than fetched, because fetching put every server in the identity
 * service's log with its address. Update with
 * `curl https://id.gryt.chat/.well-known/jwks.json`, keeping the retiring key
 * for 30 days — the certificate lifetime — or its certificates fall back to a fetch.
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
