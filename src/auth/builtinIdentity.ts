import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";

let signingKeyPrivate: CryptoKey | Uint8Array | null = null;
let publicJwk: JWK | null = null;
let jwksJson: { keys: JWK[] } | null = null;

function keyPath(): string {
  const dataDir = process.env.DATA_DIR || "./data";
  return join(dataDir, "identity-key.json");
}

export async function initBuiltinIdentity(): Promise<void> {
  const kp = keyPath();
  const dir = dirname(kp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(kp)) {
    const stored = JSON.parse(readFileSync(kp, "utf-8")) as {
      publicJwk: JWK;
      privateJwk: JWK;
    };
    publicJwk = stored.publicJwk;
    signingKeyPrivate = await importJWK(stored.privateJwk, "ES256");

    publicJwk.kid = publicJwk.kid || "builtin-1";
    publicJwk.use = "sig";
    publicJwk.alg = "ES256";
  } else {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    signingKeyPrivate = privateKey;
    const pubJwk = await exportJWK(publicKey);
    const privJwk = await exportJWK(privateKey);

    pubJwk.kid = "builtin-1";
    pubJwk.use = "sig";
    pubJwk.alg = "ES256";
    publicJwk = pubJwk;

    writeFileSync(kp, JSON.stringify({ publicJwk: pubJwk, privateJwk: privJwk }, null, 2), "utf-8");
  }

  jwksJson = { keys: [publicJwk] };
}

export function getJwksResponse(): { keys: JWK[] } {
  if (!jwksJson) throw new Error("Built-in identity not initialized");
  return jwksJson;
}

export function getIssuer(): string {
  const port = process.env.PORT || "5000";
  const host = process.env.EXTERNAL_HOST || `http://localhost:${port}`;
  return host.replace(/\/+$/, "");
}

export async function issueIdentityCertificate(
  sub: string,
  preferredUsername: string,
  userPublicJwk: JsonWebKey,
): Promise<string> {
  if (!signingKeyPrivate || !publicJwk) {
    throw new Error("Built-in identity not initialized");
  }

  const issuer = getIssuer();
  const jwt = await new SignJWT({
    sub,
    preferred_username: preferredUsername,
    jwk: userPublicJwk,
  })
    .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(signingKeyPrivate);

  return jwt;
}
