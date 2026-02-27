import { randomBytes } from "crypto";
import { createRemoteJWKSet, importJWK, jwtVerify, type JWTPayload } from "jose";

// ── Configuration ────────────────────────────────────────────────────

function getIdentityJwksUrl(): string {
  const url = process.env.GRYT_IDENTITY_JWKS_URL;
  if (!url) {
    throw new Error(
      "Missing GRYT_IDENTITY_JWKS_URL (expected something like https://id.gryt.chat/.well-known/jwks.json)"
    );
  }
  return url;
}

function getIdentityIssuer(): string {
  const issuer = process.env.GRYT_IDENTITY_ISSUER;
  if (issuer) return issuer.replace(/\/+$/, "");

  const jwksUrl = getIdentityJwksUrl();
  try {
    const url = new URL(jwksUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    throw new Error("Cannot derive identity issuer from GRYT_IDENTITY_JWKS_URL");
  }
}

// ── JWKS for Identity Service CA ─────────────────────────────────────

let identityJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getIdentityJwks() {
  if (identityJwks) return identityJwks;
  identityJwks = createRemoteJWKSet(new URL(getIdentityJwksUrl()));
  return identityJwks;
}

// ── Certificate verification ─────────────────────────────────────────

export interface VerifiedCertificate {
  sub: string;
  preferredUsername?: string;
  jwk: JsonWebKey;
}

export async function verifyCertificate(certJwt: string): Promise<VerifiedCertificate> {
  const issuer = getIdentityIssuer();
  const { payload } = await jwtVerify(certJwt, getIdentityJwks(), { issuer });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Certificate missing sub claim");
  }

  const jwk = (payload as JWTPayload & { jwk?: JsonWebKey }).jwk;
  if (!jwk || typeof jwk !== "object" || jwk.kty !== "EC") {
    throw new Error("Certificate missing or invalid jwk claim");
  }

  const preferredUsername = typeof payload["preferred_username"] === "string"
    ? payload["preferred_username"]
    : undefined;

  return { sub: payload.sub, preferredUsername, jwk };
}

// ── Assertion verification ───────────────────────────────────────────

export async function verifyAssertion(
  assertionJwt: string,
  expectedJwk: JsonWebKey,
  expectedAud: string,
  expectedNonce: string,
): Promise<{ sub: string }> {
  const publicKey = await importJWK(expectedJwk, "ES256");

  const { payload } = await jwtVerify(assertionJwt, publicKey, {
    audience: expectedAud,
  });

  if (!payload.iss || typeof payload.iss !== "string") {
    throw new Error("Assertion missing iss (subject) claim");
  }

  const nonce = (payload as JWTPayload & { nonce?: string }).nonce;
  if (nonce !== expectedNonce) {
    throw new Error("Assertion nonce mismatch");
  }

  return { sub: payload.iss };
}

// ── Nonce manager ────────────────────────────────────────────────────

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
  inviteCode?: string,
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
