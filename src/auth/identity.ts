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
 * The `iss` on a certificate where one key vouches for another.
 *
 * The SSH shape: a key you keep signs a short statement that some device key is
 * you, and the device signs the assertion with the key it actually holds. The
 * key that is your identity never has to be on the device doing the talking.
 */
const DELEGATED_ISSUER = "gryt:delegated";

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

/**
 * The issuer whose users are stored under a bare `sub` (GRYT-267).
 *
 * Every other trusted issuer gets its name written into the id, so two CAs can
 * never mean the same user. One of them has to own the unqualified namespace or
 * every existing row would have to be rewritten, and that is a migration across
 * `users`, `bans`, `server_config.owner_gryt_user_id` and `refresh_tokens` on
 * live servers with no off-box backups. The first configured issuer owns it.
 *
 * **Reordering `GRYT_TRUSTED_CERT_ISSUERS` changes who that is**, which would
 * silently re-point every account identity on the server. Add to the end of the
 * list, never to the front.
 */
function getPrimaryCertificateIssuer(): string {
  return getTrustedCertificateIssuers()[0];
}

/**
 * Separates the issuer from the `sub` in a qualified id.
 *
 * Not valid in a URL host and not produced by Keycloak, which mints UUIDs. A
 * `sub` containing it is refused outright rather than escaped: the only reason a
 * CA would send one is to try to look like a different issuer, and there is no
 * legitimate use to protect.
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
  /**
   * The subject exactly as the certificate carries it.
   *
   * What the assertion has to claim, since the client signs with the value it
   * read out of its own certificate and knows nothing about how this server
   * files people. Not what to store — see `grytUserId`.
   */
  sub: string;
  /**
   * What to store, and the only thing that should ever reach the database
   * (GRYT-267).
   *
   * For the local and delegated tiers this is the `sub`, which is derived from a
   * key and already cannot collide. For an account it carries the issuer that
   * vouched for it, unless that issuer is the primary one.
   *
   * Kept separate from `sub` rather than replacing it because the two answer
   * different questions, and a single field would have to be right for both at
   * once — which is exactly the confusion that let a second CA name somebody
   * else's user.
   */
  grytUserId: string;
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
    // Derived from the key, so it is already impossible for anything else to
    // name it. Nothing to qualify.
    grytUserId: `${LOCAL_SUB_PREFIX}${thumbprint}`,
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

/**
 * Verify a certificate where a key you hold vouches for a key on a device.
 *
 * The identity is the *signing* key, not the one being vouched for. So the
 * `sub` is derived from the key that signed the certificate, and the `jwk`
 * handed back — the one the assertion is checked against — is the device key it
 * names. One person can authorise as many devices as they like and every one of
 * them is the same `sub`.
 *
 * There is deliberately nothing here for an operator to trust or pin. It would
 * be natural to expect a delegated certificate to need an `authorized_keys`
 * equivalent, but that is only true when the identity is something its holder
 * writes down, like a username. Deriving `sub` from the signing key means a
 * delegation can only ever claim the identity of the key that signed it — the
 * same property that makes a self-signed certificate safe, one step removed.
 *
 * Revocation is expiry. There is no revocation list and no attempt at one; a
 * delegation is good until its `exp`, so a short one is how you keep a lost
 * device from being you for long.
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
 * before.
 *
 * Somebody who joined without an account and later makes one arrives with a
 * different `sub` — a Keycloak id where there was a key thumbprint — and to the
 * server is a stranger with a familiar nickname. This is how they say "that was
 * me", in the only way worth accepting: by signing with the key that *was* the
 * old identity.
 *
 * Deliberately proved to each server rather than carried in the certificate.
 * Local keys are per-server, so a certificate naming prior identities would
 * have to list every server the holder has joined — telling the CA and every
 * server that reads it their whole server list, which is the opposite of what
 * per-server keys are for.
 *
 * Bound to the same nonce and audience as the assertion, so a proof lifted from
 * one join cannot be replayed into another, or at a different server.
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
): { nonce: string; serverHost: string; identityTiers: IdentityTier[] } {
  const nonce = randomBytes(32).toString("base64url");
  pendingChallenges.set(socketId, {
    nonce,
    serverHost,
    nickname,
    inviteCode,
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
