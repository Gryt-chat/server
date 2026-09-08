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

/** `account` survives a lost device; `local` is the key itself; `bot` is
    `local`'s cryptography under its own namespace and its own gate. */
export type IdentityTier = "account" | "local" | "bot";

/** Certificates are dispatched on `iss`, never tried against each verifier:
    falling back gives a failed one a second chance under its own rules. */
const SELF_ISSUER = "gryt:self";

/** Identical cryptography to `gryt:self` under its own issuer, so the tier is
    decided at verification and one key cannot be both. */
const BOT_ISSUER = "gryt:bot";

/** A key you keep signs a statement that some device key is you, so the key
    that is your identity never has to be on the device talking. */
const DELEGATED_ISSUER = "gryt:delegated";

/** Bans, roles and ownership key on one column, so a self-signed `sub` in the
    CA's namespace would inherit whatever was left there. */
const LOCAL_SUB_PREFIX = "key:";

/** Loud and upper case, because an audit entry has to answer "was that a
    person" instantly. An underscore, so splitting on `:` cannot lose it. */
const BOT_SUB_PREFIX = "BOT_";

/** The prefix is why this needs only the id: a `sub` without one could only
    have come from a CA, so rows predating tiers need no backfill. */
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

/** The badge comes from the identity, so this is only about the benefit of the
    doubt from whoever reads quickly. Loose on separator and case. */
const BOT_LOOKALIKE = /^\s*\[?\s*bot\s*\]?\s*([_\-–—:.]|\s)/i;

/** Applied to people, not to bots: a bot's name comes from its registration and
    an operator may call it whatever they like. */
export function looksLikeABotName(nickname: string): boolean {
  return BOT_LOOKALIKE.test(nickname) || nickname.trim().toLowerCase() === "bot";
}

const DEFAULT_ACCEPTED_TIERS: IdentityTier[] = ["account"];

function parseTier(value: string): IdentityTier | null {
  return value === "account" || value === "local" ? value : null;
}

/** Defaults to `account` alone, and an unparseable or empty value falls back to
    the same rather than to something more permissive. */
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

/** Separate from `verifyCertificate`, which answers whether it is real. A
    `local` identity is regenerable, so a ban on its `sub` barely holds. */
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

/** The first configured issuer owns the unqualified namespace, so reordering
    `GRYT_TRUSTED_CERT_ISSUERS` re-points every account identity. Add at the end. */
function getPrimaryCertificateIssuer(): string {
  return getTrustedCertificateIssuers()[0];
}

/** Not valid in a URL host and not produced by Keycloak. A `sub` carrying one is
    refused rather than escaped. */
const ISSUER_SEPARATOR = "|";

/** The issuer is the one the signature was checked against, never the one the
    certificate claimed, so a CA cannot reach outside its own name. */
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

/** Null is the ordinary answer for anybody running their own CA: a key pinned in
    the binary is pinned by whoever built it. */
function getBundledIdentityJwks(normalizedIssuer: string) {
  const cached = localJwksCache.get(normalizedIssuer);
  if (cached !== undefined) return cached;

  const bundled = BUNDLED_IDENTITY_JWKS[normalizedIssuer];
  const jwks = bundled ? createLocalJWKSet(bundled) : null;
  localJwksCache.set(normalizedIssuer, jwks);
  return jwks;
}

/** Shipped keys first, because fetching the JWKS told the CA which servers
    exist. Only `JWKSNoMatchingKey` falls back; a bad signature is forged. */
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
  /** What the assertion has to claim, since the client signs the value from its
      own certificate. Not what to store — see `grytUserId`. */
  sub: string;
  /** The only thing that should reach the database. One field answering both
      this and `sub` is what let a second CA name somebody else's user. */
  grytUserId: string;
  preferredUsername?: string;
  jwk: JsonWebKey;
  issuer: string;
  tier: IdentityTier;
}

/** Generous because `consumeChallenge` bounds the replay window on this
    server's clock anyway, and dual-booting is out by a whole UTC offset. */
const NONCE_BOUND_CLOCK_TOLERANCE = "12 hours";

/** Much smaller, because a certificate's expiry is real: widening it postpones
    the moment a withdrawn identity stops working. */
const CERTIFICATE_CLOCK_TOLERANCE = "2 minutes";

/** So a client can renew a stale certificate rather than say "sign in again".
    Coarse on purpose: the exact message goes to the log, not over the wire. */
export type IdentityFailureReason =
  | "certificate_rejected"
  | "assertion_rejected"
  | "nonce_mismatch";

export class IdentityVerificationError extends Error {
  readonly reason: IdentityFailureReason;
  /** Positive means their clock is behind ours, and undefined means the failure
      was not about time. Nothing they could not read off their own clock. */
  readonly skewMs?: number;

  constructor(reason: IdentityFailureReason, message: string, skewMs?: number) {
    super(message);
    this.name = "IdentityVerificationError";
    this.reason = reason;
    this.skewMs = skewMs;
  }
}

/** From `iat`, or inferred from `exp`. Best effort, and only called once a
    verification has already failed. */
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

/** The `d` check is the one that matters: a certificate carrying a private key
    still verifies, and we would hold signing material for its identity. */
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

/** The `sub` is computed from the key and the payload's ignored, or anybody
    could claim any identity, an existing account's included, by writing it. */
async function verifySelfSignedCertificate(
  certJwt: string,
  // The issuer decides which namespace the derived subject lands in. Passed in
  // from the dispatch, so it is the value that was actually matched.
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
  // Pinned rather than left to the header: jose already refuses `none`, so this
  // states the accepted algorithm instead of inheriting a library default.
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
    // A self-signed certificate can say anything, and the join path uses a
    // certificate name as a fallback that would read as vouched-for.
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
 * The identity is the signing key, so a delegation can only claim that key's
 * identity. Revocation is expiry; there is no list.
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

  // A delegation to itself verifies happily and amounts to a self-signed
  // certificate wearing a different issuer.
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

/** Proved per server, since a certificate would list every server the holder
    joined. Bound to the assertion's nonce, so it cannot be replayed. */
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

  // Derived, never read from the payload: a link that named its own prior
  // identity would be a way to claim somebody else's.
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

  // Dispatched on the named issuer rather than tried against each in turn: the
  // loop cost a signature check per issuer on a path anybody can reach.
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
      // ES256 is what the identity service signs with, and pinning it means a CA
      // that changed algorithm fails loudly rather than widening this.
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
      // A CA issuing into the bot namespace could mint something that reads as a
      // bot everywhere, or label a person as not-a-person.
      throw new Error(
        `Certificate sub must not use the reserved "${BOT_SUB_PREFIX}" prefix`
      );
    }

    if (payload.sub.startsWith(LOCAL_SUB_PREFIX)) {
      // A CA issuing into the self-signed namespace would hand out an id a
      // keyholder could also prove.
      throw new Error(
        `Certificate sub must not use the reserved "${LOCAL_SUB_PREFIX}" prefix`
      );
    }

    if (payload.sub.includes(ISSUER_SEPARATOR)) {
      // The primary issuer's users are stored under a bare `sub`, so one that
      // already looked qualified would land on another issuer's user.
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
    // Usually the client signing with a key its certificate no longer describes;
    // the two are stored separately and drift. Naming it lets them renew.
    ({ payload } = await jwtVerify(assertionJwt, publicKey, {
      audience: expectedAud,
      // The nonce is single use and worth 60 seconds on our clock, so nothing
      // turns on the signer's. Strict, a machine an hour out could never join.
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
  /** Bound to the challenge, like the nickname: an operator is shown this, so it
      must be fixed before the identity is known. */
  bot?: BotDeclaration;
  createdAt: number;
}

const pendingChallenges = new Map<string, PendingChallenge>();

// Unref'd, so anything that only wants the verifier — a test, a script — can
// exit when it is done.
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
  // This is where the client chooses which identity to sign with, and
  // `server:info` awaits the config so it may not have arrived yet.
  return { nonce, serverHost, identityTiers: getAcceptedIdentityTiers() };
}

export function consumeChallenge(socketId: string): PendingChallenge | null {
  const challenge = pendingChallenges.get(socketId);
  if (!challenge) return null;
  pendingChallenges.delete(socketId);

  if (Date.now() - challenge.createdAt > NONCE_TTL_MS) return null;

  return challenge;
}
