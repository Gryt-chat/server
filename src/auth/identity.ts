import { randomBytes } from "crypto";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  importJWK,
  jwtVerify,
  errors as joseErrors,
  type JWK,
  type JWTPayload,
} from "jose";

import { BUNDLED_IDENTITY_JWKS } from "./bundledJwks";

// ── Identity tiers ──────────────────────────────────────────────────

/**
 * Who vouches for the key a certificate carries.
 *
 * `account` comes from a trusted CA, so the `sub` is durable and survives
 * losing the device. `local` is signed by the key it describes — the key *is*
 * the identity, which is enough to prove the same person came back and cannot
 * survive the key being lost; see the ban note on `identityTierAccepted`.
 *
 * `bot` is the same cryptography as `local` and a deliberately separate tier:
 * its own `sub` namespace, its own gate rather than `GRYT_IDENTITY_TIERS`, and
 * a marker on every surface. Sharing `local` would make a bot and a guest the
 * same kind of thing to every check that asked.
 */
export type IdentityTier = "account" | "local" | "bot";

/**
 * The `iss` a self-signed certificate must carry. Certificates are **dispatched
 * on `iss`, never tried against each verifier in turn** — falling back from the
 * CA path would give a failed certificate a second chance under rules it chose
 * for itself.
 */
const SELF_ISSUER = "gryt:self";

/**
 * The `iss` a bot's certificate must carry. Cryptographically identical to
 * `gryt:self`, and a separate issuer on purpose: dispatching on it decides the
 * tier at verification time rather than leaving something downstream to ask.
 *
 * So one key is a person *or* a bot, never both, and cannot move between them
 * by changing a field.
 */
const BOT_ISSUER = "gryt:bot";

/**
 * The `iss` on a certificate where one key vouches for another.
 *
 * The SSH shape: a key you keep signs a short statement that some device key is
 * you, and the device signs the assertion with the key it actually holds. The
 * key that is your identity never has to be on the device doing the talking.
 */
const DELEGATED_ISSUER = "gryt:delegated";

/**
 * Prefix on the `sub` of every self-signed identity. Bans, roles, ownership and
 * attribution all key on one column, so an identity that could choose a `sub`
 * in the CA's namespace would inherit whatever an account holder left there.
 * Disjoint by construction rather than by validation.
 */
const LOCAL_SUB_PREFIX = "key:";

/**
 * Prefix on the `sub` of every bot identity. Loud and upper case, because this
 * is what somebody reads in an audit entry, and the question it has to answer
 * instantly is "was that a person". Disjoint by shape, like the local prefix.
 *
 * The underscore rather than a colon is deliberate: nothing that splits on `:`
 * can lose the marker.
 */
const BOT_SUB_PREFIX = "BOT_";

/**
 * Which tier a stored `gryt_user_id` belongs to.
 *
 * The prefix is why this needs nothing but the id itself — no lookup, no column
 * and no backfill for rows written before tiers existed, since a `sub` without
 * the prefix could only ever have come from a CA.
 */
export function identityTierOf(sub: string): IdentityTier {
  if (sub.startsWith(BOT_SUB_PREFIX)) return "bot";
  if (sub.startsWith(LOCAL_SUB_PREFIX)) return "local";
  return "account";
}

/** Whether a stored id belongs to a bot. Reads off the id alone, like the tier. */
export function isBotIdentity(sub: string | null | undefined): boolean {
  return typeof sub === "string" && sub.startsWith(BOT_SUB_PREFIX);
}

/** Exported so the join path and the bot registry agree on one spelling. */
export { BOT_SUB_PREFIX };

/**
 * Names a person may not take. The badge comes from the identity, so nobody
 * gets it by naming themselves "BOT_helper" — they only get the benefit of the
 * doubt from whoever reads quickly, which is the whole trick.
 *
 * Loose on separator and case: `BOT_x`, `bot-x`, `Bot x` and `[BOT] x`.
 */
const BOT_LOOKALIKE = /^\s*\[?\s*bot\s*\]?\s*([_\-–—:.]|\s)/i;

/**
 * Whether a nickname is one only a bot should be able to hold.
 *
 * Applied to people, not to bots — a bot's name comes from its registration and
 * an operator can call it whatever they like.
 */
export function looksLikeABotName(nickname: string): boolean {
  return BOT_LOOKALIKE.test(nickname) || nickname.trim().toLowerCase() === "bot";
}

const DEFAULT_ACCEPTED_TIERS: IdentityTier[] = ["account"];

function parseTier(value: string): IdentityTier | null {
  return value === "account" || value === "local" ? value : null;
}

/**
 * Which tiers this server admits, from `GRYT_IDENTITY_TIERS`. Defaults to
 * `account` alone, and an unparseable or empty value falls back to the same
 * rather than to something more permissive.
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
 * Separate from `verifyCertificate`, which answers whether it is real: the join
 * path reads as "is this real" then "do we take it", and neither check can be
 * mistaken for the other.
 *
 * **A `local` identity is regenerable in seconds, so a ban keyed on its `sub`
 * holds until somebody clears their browser data.** Servers accepting that tier
 * lean on the entry gate rather than on bans, which is why it is off by default.
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

/**
 * The issuer whose users are stored under a bare `sub` (GRYT-267). Every other
 * trusted issuer has its name written into the id, so two CAs can never mean
 * the same user; one has to own the unqualified namespace or every existing row
 * needs rewriting. The first configured issuer owns it.
 *
 * **Reordering `GRYT_TRUSTED_CERT_ISSUERS` changes who that is** and would
 * silently re-point every account identity on the server. Add to the end of the
 * list, never to the front.
 */
function getPrimaryCertificateIssuer(): string {
  return getTrustedCertificateIssuers()[0];
}

/**
 * Separates the issuer from the `sub` in a qualified id. Not valid in a URL host
 * and not produced by Keycloak. A `sub` containing it is refused rather than
 * escaped — the only reason to send one is to look like a different issuer.
 */
const ISSUER_SEPARATOR = "|";

/**
 * What goes in `gryt_user_id` for a certificate the CA path verified.
 *
 * The issuer here is the one the signature was actually checked against, never
 * the one the certificate claimed, so a CA cannot reach outside its own name by
 * writing a different one down.
 */
function qualifiedAccountSub(issuer: string, sub: string): string {
  return normalizeUrl(issuer) === normalizeUrl(getPrimaryCertificateIssuer())
    ? sub
    : `${normalizeUrl(issuer)}${ISSUER_SEPARATOR}${sub}`;
}

function getJwksUrlForIssuer(issuer: string): string {
  return `${normalizeUrl(issuer)}/.well-known/jwks.json`;
}

// ── JWKS per issuer: bundled first, fetched only if that misses ─────

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getRemoteIdentityJwks(normalizedIssuer: string) {
  const cached = jwksCache.get(normalizedIssuer);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(
    new URL(getJwksUrlForIssuer(normalizedIssuer))
  );
  jwksCache.set(normalizedIssuer, jwks);
  return jwks;
}

const localJwksCache = new Map<
  string,
  ReturnType<typeof createLocalJWKSet> | null
>();

/**
 * The shipped keys for an issuer, or null for one we do not ship keys for.
 *
 * Null is the ordinary answer for anybody running their own CA through
 * `GRYT_TRUSTED_CERT_ISSUERS`. A key pinned in the binary is pinned by whoever
 * built it, and that is only true of the project's own.
 */
function getBundledIdentityJwks(normalizedIssuer: string) {
  const cached = localJwksCache.get(normalizedIssuer);
  if (cached !== undefined) return cached;

  const bundled = BUNDLED_IDENTITY_JWKS[normalizedIssuer];
  const jwks = bundled ? createLocalJWKSet(bundled) : null;
  localJwksCache.set(normalizedIssuer, jwks);
  return jwks;
}

/**
 * Verify against the shipped keys, and only ask the CA if they do not hold the
 * one the certificate names (GRYT-721). Fetching the JWKS told the identity
 * service which servers exist and, paired with a certificate request from the
 * same address, who runs them.
 *
 * **The fallback is only `JWKSNoMatchingKey`** — a `kid` this build has never
 * heard of, which is what a CA key rotation looks like from here. A signature
 * that fails against a key we *do* hold is not retried: the certificate is
 * forged, and retrying would let anybody reaching a join endpoint make this
 * server fetch a URL. Claims failures are not retried either.
 */
async function verifyAgainstIdentityJwks(
  certJwt: string,
  issuer: string,
  options: Parameters<typeof jwtVerify>[2]
) {
  const normalizedIssuer = normalizeUrl(issuer);
  const bundled = getBundledIdentityJwks(normalizedIssuer);

  if (bundled) {
    try {
      return await jwtVerify(certJwt, bundled, options);
    } catch (err) {
      if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw err;
      // Rotated, or a key this build predates. Ask, once, and cache it.
    }
  }

  return jwtVerify(certJwt, getRemoteIdentityJwks(normalizedIssuer), options);
}

// ── Certificate verification ────────────────────────────────────────

export interface VerifiedCertificate {
  /**
   * The subject exactly as the certificate carries it.
   *
   * What the assertion has to claim, since the client signs with the value it
   * read out of its own certificate and knows nothing about how this server
   * files people. Not what to store — see `grytUserId`.
   */
  sub: string;
  /**
   * **What to store, and the only thing that should ever reach the database**
   * (GRYT-267). The `sub` for key-derived tiers; for an account it carries the
   * issuer, unless that issuer is the primary one.
   *
   * Separate from `sub` because one field having to be right for both questions
   * at once is what let a second CA name somebody else's user.
   */
  grytUserId: string;
  preferredUsername?: string;
  jwk: JsonWebKey;
  issuer: string;
  tier: IdentityTier;
}

/**
 * How far a clock may be out before a nonce-bound proof is refused. Generous,
 * because the number buys nothing here: `consumeChallenge` deletes the nonce on
 * first read and times it out on this server's own clock, so the replay window
 * is 60 seconds whatever the other end says.
 *
 * Twelve hours because the common cause is not drift — a machine dual-booting
 * Windows and Linux disagrees with itself by its whole UTC offset.
 */
const NONCE_BOUND_CLOCK_TOLERANCE = "12 hours";

/**
 * The same, for a certificate. Much smaller, because a certificate's expiry is
 * real — widening it postpones the moment a withdrawn identity stops working.
 */
const CERTIFICATE_CLOCK_TOLERANCE = "2 minutes";

/**
 * Which half of the exchange failed, so a client can renew a stale certificate
 * instead of showing "please sign in again" to somebody it cannot help
 * (GRYT-78). It leaks nothing — the caller supplied both halves.
 *
 * **Coarse on purpose.** The exact message goes to the server log, not over the
 * wire, where it would only invite reading the verifier's internals.
 */
export type IdentityFailureReason =
  | "certificate_rejected"
  | "assertion_rejected"
  | "nonce_mismatch";

export class IdentityVerificationError extends Error {
  readonly reason: IdentityFailureReason;
  /**
   * How far the other end's clock is from ours, when that is what went wrong.
   * Positive means their clock is behind ours. Undefined for anything that is
   * not about time. It says nothing they could not read off their own clock.
   */
  readonly skewMs?: number;

  constructor(reason: IdentityFailureReason, message: string, skewMs?: number) {
    super(message);
    this.name = "IdentityVerificationError";
    this.reason = reason;
    this.skewMs = skewMs;
  }
}

/**
 * The gap between what a proof thought the time was and what we think it is.
 * From `iat`, or inferred from `exp` by assuming the signer's lifetime. Best
 * effort, and only called once a verification has already failed.
 */
function clockSkewOf(
  jwt: string,
  assumedLifetimeSeconds: number
): number | undefined {
  let payload: JWTPayload;
  try {
    payload = decodeJwt(jwt);
  } catch {
    return undefined;
  }

  const signedAt =
    typeof payload.iat === "number"
      ? payload.iat
      : typeof payload.exp === "number"
      ? payload.exp - assumedLifetimeSeconds
      : undefined;

  if (signedAt === undefined) return undefined;
  return Date.now() - signedAt * 1000;
}

/**
 * Is this an EC P-256 public key, and only a public key? **The `d` check is the
 * one that matters**: a certificate carrying a private key still verifies, and
 * we would then hold signing material for somebody else's identity.
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
 * Verify a certificate that vouches for itself. The signature proves only that
 * whoever made it held that private key, which is the whole claim.
 *
 * **The `sub` is computed from the key and the payload's is ignored.** That is
 * what makes the tier safe: reading it off the payload would let anybody claim
 * any identity, including an existing account's, by writing it down.
 */
async function verifySelfSignedCertificate(
  certJwt: string,
  // Which of the two self-signing issuers this certificate claimed. The
  // cryptography is identical; the issuer decides which namespace the derived
  // subject lands in, and therefore which tier the holder is. Passed in from the
  // dispatch rather than read from the payload here, so it is the value that was
  // actually matched and verified against.
  kind: { issuer: string; prefix: string; tier: IdentityTier },
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
    issuer: kind.issuer,
    algorithms: ["ES256"],
    clockTolerance: CERTIFICATE_CLOCK_TOLERANCE,
  });

  const thumbprint = await calculateJwkThumbprint(jwk, "sha256");

  return {
    sub: `${kind.prefix}${thumbprint}`,
    // Derived from the key, so it is already impossible for anything else to
    // name it. Nothing to qualify.
    grytUserId: `${kind.prefix}${thumbprint}`,
    // No `preferred_username`. A self-signed certificate can say anything, so
    // a name in one is worth nothing — and the join path already prefers the
    // nickname the client sent, with the certificate's name as a fallback. A
    // fallback that is self-asserted would read as vouched-for and is not.
    preferredUsername: undefined,
    jwk: jwk as JsonWebKey,
    issuer: kind.issuer,
    tier: kind.tier,
  };
}

/** The two issuers where a key signs for itself, and what each one becomes. */
const SELF_SIGNING_KINDS = [
  { issuer: SELF_ISSUER, prefix: LOCAL_SUB_PREFIX, tier: "local" as const },
  { issuer: BOT_ISSUER, prefix: BOT_SUB_PREFIX, tier: "bot" as const },
];

/**
 * Verify a certificate where a key you hold vouches for a key on a device. The
 * identity is the *signing* key: `sub` comes from it, and the `jwk` handed back
 * is the device key it names. One person, as many devices as they like.
 *
 * Nothing here for an operator to trust or pin, deliberately. An
 * `authorized_keys` equivalent only matters when the identity is something its
 * holder writes down — deriving `sub` from the signing key means a delegation
 * can only claim the identity of the key that signed it.
 *
 * **Revocation is expiry.** There is no revocation list, so a short `exp` is how
 * a lost device stops being you.
 */
async function verifyDelegatedCertificate(
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

  const payload = unverified as JWTPayload & {
    jwk?: unknown;
    iss_jwk?: unknown;
  };

  // The key that signed this, carried so the signature can be checked at all.
  const signingJwk = assertPublicP256Jwk(payload.iss_jwk);
  // The key the device will actually sign assertions with.
  const deviceJwk = assertPublicP256Jwk(payload.jwk);

  const signingThumbprint = await calculateJwkThumbprint(signingJwk, "sha256");
  const deviceThumbprint = await calculateJwkThumbprint(deviceJwk, "sha256");

  // A delegation to itself is not a delegation. It would verify happily and
  // amount to a self-signed certificate wearing a different issuer, which is a
  // second way to say the same thing and a second thing to reason about.
  if (signingThumbprint === deviceThumbprint) {
    throw new Error("Delegated certificate names its own signing key");
  }

  const signingKey = await importJWK(signingJwk, "ES256");
  await jwtVerify(certJwt, signingKey, {
    issuer: DELEGATED_ISSUER,
    algorithms: ["ES256"],
    clockTolerance: CERTIFICATE_CLOCK_TOLERANCE,
  });

  return {
    sub: `${LOCAL_SUB_PREFIX}${signingThumbprint}`,
    grytUserId: `${LOCAL_SUB_PREFIX}${signingThumbprint}`,
    // Self-asserted, so worth nothing — same reasoning as the self-signed path.
    preferredUsername: undefined,
    // The device key, because that is what signs the assertion. Handing back
    // the signing key here would reject every delegated join.
    jwk: deviceJwk as JsonWebKey,
    issuer: DELEGATED_ISSUER,
    tier: "local",
  };
}

/** The `iss` on a proof that one identity is claiming to become another. */
const LINK_ISSUER = "gryt:link";

/**
 * Verify that whoever is joining also holds a local identity they used here
 * before — said by signing with the key that *was* the old identity, which is
 * the only way worth accepting.
 *
 * Proved to each server rather than carried in the certificate: local keys are
 * per-server, so a certificate naming prior identities would list every server
 * the holder has joined.
 *
 * Bound to the same nonce and audience as the assertion, so a proof lifted from
 * one join cannot be replayed into another or at a different server.
 */
export async function verifyIdentityLink(
  linkJwt: string,
  expectedAud: string,
  expectedNonce: string,
  expectedTarget: string
): Promise<{ priorSub: string }> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(linkJwt);
  } catch {
    throw new IdentityVerificationError(
      "assertion_rejected",
      "Identity link is not a well-formed JWT"
    );
  }

  const jwk = assertPublicP256Jwk(
    (unverified as JWTPayload & { jwk?: unknown }).jwk
  );

  try {
    const publicKey = await importJWK(jwk, "ES256");
    const { payload } = await jwtVerify(linkJwt, publicKey, {
      issuer: LINK_ISSUER,
      audience: expectedAud,
      algorithms: ["ES256"],
      // Nonce-bound, exactly like the assertion, so the same reasoning applies.
      clockTolerance: NONCE_BOUND_CLOCK_TOLERANCE,
    });

    if (payload.nonce !== expectedNonce) {
      throw new Error("Identity link nonce mismatch");
    }

    // Naming the identity being claimed is what stops a proof for one account
    // being replayed to attach the same old identity to a different one.
    if (payload["link_to"] !== expectedTarget) {
      throw new Error("Identity link does not name this identity");
    }
  } catch (err) {
    throw new IdentityVerificationError(
      "assertion_rejected",
      `Identity link rejected: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Derived, never read from the payload — the same rule that makes a
  // self-signed certificate safe. A link that could name its own prior identity
  // would be a way to claim somebody else's.
  const thumbprint = await calculateJwkThumbprint(jwk, "sha256");
  return { priorSub: `${LOCAL_SUB_PREFIX}${thumbprint}` };
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

  const selfKind = SELF_SIGNING_KINDS.find((k) => k.issuer === claimedIssuer);
  if (selfKind) {
    try {
      return await verifySelfSignedCertificate(certJwt, selfKind);
    } catch (err) {
      throw new IdentityVerificationError(
        "certificate_rejected",
        `Self-signed certificate verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  if (claimedIssuer === DELEGATED_ISSUER) {
    try {
      return await verifyDelegatedCertificate(certJwt);
    } catch (err) {
      throw new IdentityVerificationError(
        "certificate_rejected",
        `Delegated certificate verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Dispatched on the issuer the certificate names, matched against the trusted
  // list, rather than tried against each in turn. One trusted issuer made the
  // difference invisible; more than one makes the loop a liability. A rejected
  // certificate used to cost a signature check per trusted issuer on a path
  // anybody can reach before joining, and a single unreachable issuer early in
  // the list added its JWKS fetch timeout to every join behind it.
  const claimed = normalizeUrl(String(claimedIssuer ?? ""));
  const issuer = getTrustedCertificateIssuers().find(
    (candidate) => normalizeUrl(candidate) === claimed
  );

  if (!issuer) {
    throw new IdentityVerificationError(
      "certificate_rejected",
      `Certificate issuer is not trusted by this server: ${claimed || "(none)"}`
    );
  }

  try {
    const { payload } = await verifyAgainstIdentityJwks(
      certJwt,
      issuer,
      // ES256 is what the identity service signs with (`CA_ALG`). Pinning it
      // here means a CA that changed algorithm would fail loudly at
      // verification rather than quietly widening what this accepts.
      {
        issuer,
        algorithms: ["ES256"],
        clockTolerance: CERTIFICATE_CLOCK_TOLERANCE,
      }
    );

    if (!payload.sub || typeof payload.sub !== "string") {
      throw new Error("Certificate missing sub claim");
    }

    const jwk = assertPublicP256Jwk(
      (payload as JWTPayload & { jwk?: unknown }).jwk
    );

    if (payload.sub.startsWith(BOT_SUB_PREFIX)) {
      // The same argument as the local prefix below, and it matters more. A CA
      // that could issue into the bot namespace could mint something that reads
      // as a bot everywhere it is shown — or, worse, hand a person an id that
      // every surface labels as not-a-person.
      throw new Error(
        `Certificate sub must not use the reserved "${BOT_SUB_PREFIX}" prefix`
      );
    }

    if (payload.sub.startsWith(LOCAL_SUB_PREFIX)) {
      // A CA has no business issuing into the self-signed namespace, and if
      // one ever did it would hand out an id that a keyholder could also
      // prove. Refusing here keeps the two namespaces disjoint from both
      // ends rather than only from the side we control.
      throw new Error(
        `Certificate sub must not use the reserved "${LOCAL_SUB_PREFIX}" prefix`
      );
    }

    if (payload.sub.includes(ISSUER_SEPARATOR)) {
      // Same argument one level up. The primary issuer's users are stored under
      // a bare `sub`, so a primary-issued `sub` that already looked qualified
      // would land on the id a different issuer's user gets. Nothing legitimate
      // sends one — Keycloak mints UUIDs.
      throw new Error(
        `Certificate sub must not contain "${ISSUER_SEPARATOR}"`
      );
    }

    const preferredUsername =
      typeof payload["preferred_username"] === "string"
        ? payload["preferred_username"]
        : undefined;

    return {
      sub: payload.sub,
      grytUserId: qualifiedAccountSub(issuer, payload.sub),
      preferredUsername,
      jwk: jwk as JsonWebKey,
      issuer,
      tier: "account",
    };
  } catch (err) {
    throw new IdentityVerificationError(
      "certificate_rejected",
      `Certificate verification failed for ${issuer}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
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
      // The assertion is worth 60 seconds by its own `exp`, which is a window
      // measured on the signer's clock. The nonce it carries is worth 60
      // seconds on ours, single use, so nothing here turns on the signer being
      // right about the time. This used to be strict and it made a machine an
      // hour out permanently unable to join anything — including through the
      // client's renew-and-retry, which signs the second assertion from the
      // same wrong clock as the first.
      clockTolerance: NONCE_BOUND_CLOCK_TOLERANCE,
    }));
  } catch (err) {
    throw new IdentityVerificationError(
      "assertion_rejected",
      err instanceof Error ? err.message : String(err),
      // 60 is `signAssertion`'s lifetime on the client, used only to place an
      // assertion that did not set `iat` — every current client does.
      err instanceof joseErrors.JWTExpired
        ? clockSkewOf(assertionJwt, 60)
        : undefined
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

/** What a bot declares about itself when it first turns up. */
export interface BotDeclaration {
  permissions: string[];
  description?: string;
  /** A pre-approved registration's token, for the unattended path. */
  claimToken?: string;
}

interface PendingChallenge {
  nonce: string;
  serverHost: string;
  nickname: string;
  inviteCode?: string;
  /**
   * Bound to the challenge rather than read from the verify payload, for the
   * same reason the nickname is: it is what an operator will be shown, so it
   * must be fixed before the identity is known and cannot be swapped between
   * the two halves of the exchange.
   */
  bot?: BotDeclaration;
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
  inviteCode?: string,
  bot?: BotDeclaration
): { nonce: string; serverHost: string; identityTiers: IdentityTier[] } {
  const nonce = randomBytes(32).toString("base64url");
  pendingChallenges.set(socketId, {
    nonce,
    serverHost,
    nickname,
    inviteCode,
    bot,
    createdAt: Date.now(),
  });
  // The accepted tiers ride along with the challenge because this is the moment
  // the client has to choose which identity to sign with, and `server:info`
  // cannot be relied on to have arrived: it is emitted on connect but awaits the
  // config first, while this is emitted synchronously in reply to `server:join`.
  // Sending it here means the client is never choosing blind.
  return { nonce, serverHost, identityTiers: getAcceptedIdentityTiers() };
}

export function consumeChallenge(socketId: string): PendingChallenge | null {
  const challenge = pendingChallenges.get(socketId);
  if (!challenge) return null;
  pendingChallenges.delete(socketId);

  if (Date.now() - challenge.createdAt > NONCE_TTL_MS) return null;

  return challenge;
}
