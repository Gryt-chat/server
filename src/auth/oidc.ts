import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type VerifiedIdentity = {
  sub: string;
  preferredUsername?: string;
  email?: string;
  raw: JWTPayload;
};

function getIssuer(): string {
  const issuer = process.env.GRYT_OIDC_ISSUER;
  if (!issuer) {
    throw new Error('Missing GRYT_OIDC_ISSUER (expected something like https://auth.gryt.chat/realms/gryt)');
  }
  return issuer.replace(/\/+$/, '');
}

function getExpectedAudience(): string | undefined {
  const aud = process.env.GRYT_OIDC_AUDIENCE;
  return aud && aud.trim().length > 0 ? aud.trim() : undefined;
}

function audienceMatches(payload: JWTPayload, expected: string): boolean {
  const aud = payload.aud;
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

function parsePreferredUsername(payload: JWTPayload): string | undefined {
  const v = payload['preferred_username'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function parseEmail(payload: JWTPayload): string | undefined {
  const v = payload['email'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function parseAzp(payload: JWTPayload): string | undefined {
  const v = payload['azp'];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (jwks) return jwks;
  const issuer = getIssuer();
  const certsUrl = new URL(`${issuer}/protocol/openid-connect/certs`);
  jwks = createRemoteJWKSet(certsUrl);
  return jwks;
}

export async function verifyIdentityToken(identityToken: string): Promise<VerifiedIdentity> {
  const issuer = getIssuer();
  const expectedAud = getExpectedAudience();
  const { payload } = await jwtVerify(identityToken, getJwks(), {
    issuer,
  });

  // Enforce that this token is meant for our Gryt client.
  // Keycloak often sets `azp` (authorized party) to the clientId for access tokens.
  if (expectedAud) {
    const azp = parseAzp(payload);
    const ok = (azp && azp === expectedAud) || audienceMatches(payload, expectedAud);
    if (!ok) {
      throw new Error(`OIDC token audience mismatch (expected ${expectedAud})`);
    }
  }

  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('OIDC token missing sub');
  }

  return {
    sub: payload.sub,
    preferredUsername: parsePreferredUsername(payload),
    email: parseEmail(payload),
    raw: payload,
  };
}

