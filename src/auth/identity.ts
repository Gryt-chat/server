import { randomBytes } from "crypto";
import {
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type JWTPayload,
} from "jose";

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
}

export async function verifyCertificate(
  certJwt: string
): Promise<VerifiedCertificate> {
  const issuers = getTrustedCertificateIssuers();
  const errors: string[] = [];

  for (const issuer of issuers) {
    try {
      const { payload } = await jwtVerify(
        certJwt,
        getIdentityJwksForIssuer(issuer),
        { issuer }
      );

      if (!payload.sub || typeof payload.sub !== "string") {
        throw new Error("Certificate missing sub claim");
      }

      const jwk = (payload as JWTPayload & { jwk?: JsonWebKey }).jwk;
      if (!jwk || typeof jwk !== "object" || jwk.kty !== "EC") {
        throw new Error("Certificate missing or invalid jwk claim");
      }

      const preferredUsername =
        typeof payload["preferred_username"] === "string"
          ? payload["preferred_username"]
          : undefined;

      return {
        sub: payload.sub,
        preferredUsername,
        jwk,
        issuer,
      };
    } catch (err) {
      errors.push(
        `${issuer}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throw new Error(
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

  const { payload } = await jwtVerify(assertionJwt, publicKey, {
    audience: expectedAud,
  });

  const sub =
    typeof payload.sub === "string"
      ? payload.sub
      : typeof payload.iss === "string"
      ? payload.iss
      : null;

  if (!sub) {
    throw new Error("Assertion missing sub/iss claim");
  }

  const nonce = (payload as JWTPayload & { nonce?: string }).nonce;
  if (nonce !== expectedNonce) {
    throw new Error("Assertion nonce mismatch");
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

setInterval(() => {
  const now = Date.now();
  for (const [key, challenge] of pendingChallenges) {
    if (now - challenge.createdAt > NONCE_TTL_MS) {
      pendingChallenges.delete(key);
    }
  }
}, 30_000);

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
