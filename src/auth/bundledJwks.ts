import type { JWK } from "jose";

/**
 * The identity CA's public keys, shipped rather than fetched (GRYT-721).
 *
 * ## The problem this removes
 *
 * A server verifying an account certificate fetched
 * `https://id.gryt.chat/.well-known/jwks.json` every time its cache expired.
 * That request tells the identity service two things it has no business knowing.
 *
 * First, a census: every Gryt server that has ever admitted an account holder
 * shows up in that log, with its address. Gryt is meant to be a thing you can
 * run without telling anybody, and this was the one place it phoned home.
 *
 * Second, and worse for the people it affects most: a certificate request and a
 * JWKS fetch from the same address means that person runs that server. On a
 * self-hosted platform that is not a rare shape, and neither request had to
 * name the other for the pair to say it.
 *
 * ## Why shipping a public key is not a compromise
 *
 * This is what a root store is. The key is public, it is the same key for
 * everybody, and pinning it makes verification *stronger* rather than weaker —
 * a server that never asks cannot be handed a different answer.
 *
 * ## Rotation still works
 *
 * `identity.ts` falls back to the remote set when the bundled one has no key
 * matching the certificate's `kid`, which is what a rotation looks like. It
 * does not fall back when a matching key is present and the signature fails:
 * that is a forged certificate, and anybody who can reach a join endpoint could
 * otherwise make this server fetch a URL by sending one.
 *
 * So a rotation costs one fetch per server until the key is updated here, and
 * an old build keeps working instead of refusing every account holder.
 *
 * ## Updating this
 *
 * `curl https://id.gryt.chat/.well-known/jwks.json`. Keep the retiring key
 * alongside the new one for as long as certificates it signed are still valid —
 * they last 30 days — or every one of those falls through to a fetch.
 *
 * Only issuers listed here are bundled. A `GRYT_TRUSTED_CERT_ISSUERS` naming
 * somebody else's CA goes straight to the network, which is right: this is a
 * key pinned by whoever built the binary, and only the project's own CA is that.
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
