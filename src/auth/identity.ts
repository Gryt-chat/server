import { randomBytes } from "crypto";
import {
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeJwt,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";

// ── Identity tiers ──────────────────────────────────────────────────

/**
 * Who vouches for the key a certificate carries.
 *
 * `account` is a certificate from a trusted CA — today that is id.gryt.chat,
 * which issues only after Keycloak has authenticated somebody, so the `sub` is
 * a durable account that survives losing the device.
 *
 * `local` is a certificate signed by the very key it describes. Nobody vouches
 * for it; the key is the identity. That is enough to join a server, because
 * joining only ever needed proof that the same person came back, and a
 * challenge-response over P-256 proves that on its own. What it cannot do is
 * survive the key being lost, and it costs nothing to mint another — see the
 * ban note on `identityTierAccepted`.
 */
export type IdentityTier = "account" | "local";

/**
 * The `iss` a self-signed certificate must carry.
 *
 * Certificates are dispatched on `iss` rather than by trying each verifier in
 * turn, so a certificate is only ever checked the one way its issuer claims.
 * Falling back from the CA path to the self-signed path on failure would mean a
 * certificate that fails CA verification gets a second chance at being accepted
 * under rules it chose for itself.
 */
const SELF_ISSUER = "gryt:self";

/**
 * Prefix on the `sub` of every self-signed identity.
 *
 * Keeps the two tiers in separate namespaces for good. `gryt_user_id` is one
 * column, and bans, roles, ownership and message attribution are all keyed on
 * it, so an identity that could choose a `sub` in the CA's namespace could
 * inherit whatever an account holder had left there. Prefixing makes that
 * impossible by construction rather than by validation, and it means the tier
 * can be read back off any stored id without a schema change.
 */
const LOCAL_SUB_PREFIX = "key:";

/**
 * Which tier a stored `gryt_user_id` belongs to.
 *
 * The prefix is why this needs nothing but the id itself — no lookup, no column
 * and no backfill for rows written before tiers existed, since a `sub` without
 * the prefix could only ever have come from a CA.
 */
export function identityTierOf(sub: string): IdentityTier {
  return sub.startsWith(LOCAL_SUB_PREFIX) ? "local" : "account";
}

const DEFAULT_ACCEPTED_TIERS: IdentityTier[] = ["account"];

function parseTier(value: string): IdentityTier | null {
  return value === "account" || value === "local" ? value : null;
}

/**
 * Which tiers this server admits, from `GRYT_IDENTITY_TIERS`.
 *
 * Defaults to `account` alone, so a server that has not been told to accept
 * anything else behaves exactly as it did before this existed. An unparseable
 * or empty value falls back to the same default rather than to something more
 * permissive.
 */
export function getAcceptedIdentityTiers(): IdentityTier[] {
  const raw = process.env.GRYT_IDENTITY_TIERS || "";
  const configured = raw
    .split(",")
    .map((s) => parseTier(s.trim().toLowerCase()))
    .filter((t): t is IdentityTier => t !== null);

  return configured.length > 0
    ? Array.from(new Set(configured))
    : DEFAULT_ACCEPTED_TIERS;
}

/**
 * Whether a verified certificate is one this server is willing to admit.
 *
 * Deliberately separate from verification. `verifyCertificate` answers whether
 * a certificate is real, which is a question about cryptography and has one
 * answer everywhere. This answers whether the operator wants it, which is
 * policy and differs per server. Keeping them apart means the join path reads
 * as "is this real" then "do we take it", and neither check can be mistaken for
 * the other.
 *
 * A `local` identity is regenerable in about two seconds, so a ban keyed on its
 * `sub` holds only until somebody bothers to clear their browser data. Servers
 * that accept this tier are choosing to lean on the entry gate — invites,
 * `lan_open`, approval — rather than on bans. That is a real trade, and it is
 * why this is off unless an operator turns it on.
 */
export function identityTierAccepted(tier: IdentityTier): boolean {
  return getAcceptedIdentityTiers().includes(tier);
}

// ── Trusted certificate issuers ─────────────────────────────────────

const DEFAULT_TRUSTED_CERT_ISSUERS = ["https://id.gryt.chat"];

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "").trim();
}

function getTrustedCertificateIssuers(): string[] {
  const raw = process.env.GRYT_TRUSTED_CERT_ISSUERS || "";
  const configured = raw
    .split(",")
    .map((s) => normalizeUrl(s))
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_TRUSTED_CERT_ISSUERS;
}

function getJwksUrlForIssuer(issuer: string): string {
  return `${normalizeUrl(issuer)}/.well-known/jwks.json`;
}

// ── JWKS cache per issuer ───────────────────────────────────────────

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getIdentityJwksForIssuer(issuer: string) {
  const normalizedIssuer = normalizeUrl(issuer);
  const cached = jwksCache.get(normalizedIssuer);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(
    new URL(getJwksUrlForIssuer(normalizedIssuer))
  );
  jwksCache.set(normalizedIssuer, jwks);
  return jwks;
}

// ── Certificate verification ────────────────────────────────────────

export interface VerifiedCertificate {
  sub: string;
  preferredUsername?: string;
  jwk: JsonWebKey;
  issuer: string;
  tier: IdentityTier;
}

/**
 * Which half of the exchange failed.
 *
 * Sent to the client so it can decide whether to repair itself. Nothing here
 * tells a caller anything they could not already work out: they supplied both
 * the certificate and the assertion, so they can tell which one is bad by
 * changing one and trying again. What it does buy is a client that renews a
 * stale certificate on its own instead of showing "please sign in again" to
 * someone for whom signing in again cannot help — see GRYT-78.
 *
 * The reason stays coarse on purpose. The exact message goes to the server log,
 * where it is useful, and not over the wire, where it only invites reading the
 * verifier's internals.
 */
export type IdentityFailureReason =
  | "certificate_rejected"
  | "assertion_rejected"
  | "nonce_mismatch";

export class IdentityVerificationError extends Error {
  readonly reason: IdentityFailureReason;

  constructor(reason: IdentityFailureReason, message: string) {
    super(message);
    this.name = "IdentityVerificationError";
    this.reason = reason;
  }
}

/**
 * Is this an EC P-256 public key, and only a public key?
 *
 * The `d` check is the one that matters. A certificate carrying a private key
 * would still verify, and we would then hold signing material for somebody
 * else's identity — which is not an attack on us so much as a thing we must
 * never accept and never store.
 */
function assertPublicP256Jwk(value: unknown): JWK {
  if (!value || typeof value !== "object") {
    throw new Error("Certificate missing or invalid jwk claim");
  }
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new Error("Certificate jwk must be an EC P-256 key");
  }
  if (typeof jwk.d === "string") {
    throw new Error("Certificate jwk contains private key material");
  }
  return value as JWK;
}

/**
 * Verify a certificate that vouches for itself.
 *
 * The signature is checked against the key the certificate carries, which
 * proves only that whoever made it held that private key. That is the whole
 * claim being made, and it is exactly as strong as the assertion check that
 * follows it.
 *
 * The `sub` is computed here from the key and the one in the payload is
 * ignored. This is the line that makes the tier safe: reading `sub` off a
 * self-signed payload would let anybody claim any identity on the server simply
 * by writing it down, including an existing account's. Deriving it means a
 * self-signed identity can only ever be the one key it can prove it holds.
 */
async function verifySelfSignedCertificate(
  certJwt: string
): Promise<VerifiedCertificate> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(certJwt);
  } catch (err) {
    throw new Error(
      `Certificate is not a well-formed JWT: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const jwk = assertPublicP256Jwk(
    (unverified as JWTPayload & { jwk?: unknown }).jwk
  );

  const publicKey = await importJWK(jwk, "ES256");
  // `algorithms` pinned rather than left to the header. jose already refuses
  // `none` and will not hand an EC key to an HMAC verifier, so this is not
  // closing an open door — it means the accepted algorithm is stated here
  // instead of being a property of a library's defaults.
  await jwtVerify(certJwt, publicKey, {
    issuer: SELF_ISSUER,
    algorithms: ["ES256"],
  });

  const thumbprint = await calculateJwkThumbprint(jwk, "sha256");

  return {
    sub: `${LOCAL_SUB_PREFIX}${thumbprint}`,
    // No `preferred_username`. A self-signed certificate can say anything, so
    // a name in one is worth nothing — and the join path already prefers the
    // nickname the client sent, with the certificate's name as a fallback. A
    // fallback that is self-asserted would read as vouched-for and is not.
    preferredUsername: undefined,
    jwk: jwk as JsonWebKey,
    issuer: SELF_ISSUER,
    tier: "local",
  };
}

export async function verifyCertificate(
  certJwt: string
): Promise<VerifiedCertificate> {
  // Dispatch on the issuer the certificate names, so each one is checked the
  // single way its own claim implies.
  let claimedIssuer: unknown;
  try {
    claimedIssuer = decodeJwt(certJwt).iss;
  } catch {
    throw new IdentityVerificationError(
      "certificate_rejected",
      "Certificate is not a well-formed JWT"
    );
  }

  if (claimedIssuer === SELF_ISSUER) {
    try {
      return await verifySelfSignedCertificate(certJwt);
    } catch (err) {
      throw new IdentityVerificationError(
        "certificate_rejected",
        `Self-signed certificate verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const issuers = getTrustedCertificateIssuers();
  const errors: string[] = [];

  for (const issuer of issuers) {
    try {
      const { payload } = await jwtVerify(
        certJwt,
        getIdentityJwksForIssuer(issuer),
        // ES256 is what the identity service signs with (`CA_ALG`). Pinning it
        // here means a CA that changed algorithm would fail loudly at
        // verification rather than quietly widening what this accepts.
        { issuer, algorithms: ["ES256"] }
      );

      if (!payload.sub || typeof payload.sub !== "string") {
        throw new Error("Certificate missing sub claim");
      }

      const jwk = assertPublicP256Jwk(
        (payload as JWTPayload & { jwk?: unknown }).jwk
      );

      if (payload.sub.startsWith(LOCAL_SUB_PREFIX)) {
        // A CA has no business issuing into the self-signed namespace, and if
        // one ever did it would hand out an id that a keyholder could also
        // prove. Refusing here keeps the two namespaces disjoint from both
        // ends rather than only from the side we control.
        throw new Error(
          `Certificate sub must not use the reserved "${LOCAL_SUB_PREFIX}" prefix`
        );
      }

      const preferredUsername =
        typeof payload["preferred_username"] === "string"
          ? payload["preferred_username"]
          : undefined;

      return {
        sub: payload.sub,
        preferredUsername,
        jwk: jwk as JsonWebKey,
        issuer,
        tier: "account",
      };
    } catch (err) {
      errors.push(
        `${issuer}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throw new IdentityVerificationError(
    "certificate_rejected",
    `Certificate verification failed for all trusted issuers: ${errors.join(
      " | "
    )}`
  );
}

// ── Assertion verification ──────────────────────────────────────────

export async function verifyAssertion(
  assertionJwt: string,
  expectedJwk: JsonWebKey,
  expectedAud: string,
  expectedNonce: string
): Promise<{ sub: string }> {
  const publicKey = await importJWK(expectedJwk, "ES256");

  let payload: JWTPayload;
  try {
    // The key comes from the certificate, so a failure here is usually the
    // client signing with a key the certificate no longer describes — the two
    // are stored separately on the client and can drift apart. Naming that is
    // what lets the client renew instead of asking the user to sign in again.
    ({ payload } = await jwtVerify(assertionJwt, publicKey, {
      audience: expectedAud,
    }));
  } catch (err) {
    throw new IdentityVerificationError(
      "assertion_rejected",
      err instanceof Error ? err.message : String(err)
    );
  }

  const sub =
    typeof payload.sub === "string"
      ? payload.sub
      : typeof payload.iss === "string"
      ? payload.iss
      : null;

  if (!sub) {
    throw new IdentityVerificationError(
      "assertion_rejected",
      "Assertion missing sub/iss claim"
    );
  }

  const nonce = (payload as JWTPayload & { nonce?: string }).nonce;
  if (nonce !== expectedNonce) {
    // Its own reason: a stale nonce means the challenge was reused or raced,
    // and retrying the join fixes it. Renewing the certificate would not.
    throw new IdentityVerificationError(
      "nonce_mismatch",
      "Assertion nonce mismatch"
    );
  }

  return { sub };
}

// ── Nonce manager ───────────────────────────────────────────────────

const NONCE_TTL_MS = 60_000;

interface PendingChallenge {
  nonce: string;
  serverHost: string;
  nickname: string;
  inviteCode?: string;
  createdAt: number;
}

const pendingChallenges = new Map<string, PendingChallenge>();

// Unref'd so importing this module does not by itself hold the process open.
// The server runs forever regardless, but anything that only wants the
// verifier — a test, a script — should be able to exit when it is done.
setInterval(() => {
  const now = Date.now();
  for (const [key, challenge] of pendingChallenges) {
    if (now - challenge.createdAt > NONCE_TTL_MS) {
      pendingChallenges.delete(key);
    }
  }
}, 30_000).unref();

export function createChallenge(
  socketId: string,
  serverHost: string,
  nickname: string,
  inviteCode?: string
): { nonce: string; serverHost: string } {
  const nonce = randomBytes(32).toString("base64url");
  pendingChallenges.set(socketId, {
    nonce,
    serverHost,
    nickname,
    inviteCode,
    createdAt: Date.now(),
  });
  return { nonce, serverHost };
}

export function consumeChallenge(socketId: string): PendingChallenge | null {
  const challenge = pendingChallenges.get(socketId);
  if (!challenge) return null;
  pendingChallenges.delete(socketId);

  if (Date.now() - challenge.createdAt > NONCE_TTL_MS) return null;

  return challenge;
}
