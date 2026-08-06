import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import consola from "consola";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
} from "jose";

// The server's long-lived identity, used to prove to a client that it is the
// same server the client joined before (GRYT-51). Deliberately separate from
// `builtinIdentity`, which is a certificate authority for *user* identity and
// only exists when IDENTITY_MODE=builtin. This key always exists.
//
// It is also separate from `server_id`, which goes out unauthenticated over
// mDNS and is a discovery hint, never a credential.

interface ServerIdentity {
  privateKey: CryptoKey | Uint8Array;
  publicJwk: JWK;
  keyId: string;
}

const PROOF_TTL_SECONDS = 60;

// Everything in index.ts initializes fire-and-forget, so a join can arrive
// before startup has finished. Memoizing the promise here means the first
// caller starts the work and every other caller waits for the same result,
// rather than depending on an ordering that isn't guaranteed.
let identityPromise: Promise<ServerIdentity> | null = null;

function keyPath(): string {
  const dataDir = process.env.DATA_DIR || "./data";
  return join(dataDir, "server-identity-key.json");
}

async function load(): Promise<ServerIdentity> {
  const kp = keyPath();
  const dir = dirname(kp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let publicJwk: JWK;
  let privateKey: CryptoKey | Uint8Array;

  if (existsSync(kp)) {
    const stored = JSON.parse(readFileSync(kp, "utf-8")) as {
      publicJwk: JWK;
      privateJwk: JWK;
    };
    publicJwk = stored.publicJwk;
    privateKey = await importJWK(stored.privateJwk, "ES256");
  } else {
    const kp2 = await generateKeyPair("ES256", { extractable: true });
    privateKey = kp2.privateKey;
    publicJwk = await exportJWK(kp2.publicKey);
    const privateJwk = await exportJWK(kp2.privateKey);

    // 0600: the private half is the server's identity. Another user on the box
    // reading this file can impersonate this server to every client that has
    // pinned it.
    writeFileSync(kp, JSON.stringify({ publicJwk, privateJwk }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  publicJwk.use = "sig";
  publicJwk.alg = "ES256";

  // The thumbprint (RFC 7638) is what a client pins, and what it files the
  // server under. It survives the host and port changing, which today's
  // host:port keying does not.
  const keyId = await calculateJwkThumbprint(publicJwk, "sha256");
  publicJwk.kid = keyId;

  return { privateKey, publicJwk, keyId };
}

export function initServerIdentity(): Promise<ServerIdentity> {
  if (!identityPromise) {
    identityPromise = load().catch((err) => {
      // Don't cache a failure — a transient filesystem problem shouldn't
      // disable server proofs until the next restart.
      identityPromise = null;
      throw err;
    });
  }
  return identityPromise;
}

export async function getServerKeyId(): Promise<string> {
  return (await initServerIdentity()).keyId;
}

export async function getServerPublicJwk(): Promise<JWK> {
  return (await initServerIdentity()).publicJwk;
}

/**
 * Sign a proof of possession of the server identity key, bound to a nonce the
 * client chose for this connection.
 *
 * The public key travels in the protected header so a client joining for the
 * first time has something to pin. That embedded key proves nothing on its own
 * — the JWT is self-signed, and an impostor can produce an equally valid one
 * over a key it generated. It only means anything once the client has a pinned
 * key to check the signature against. That is the trust-on-first-use
 * assumption, the same one SSH makes on a first connection.
 */
export async function signServerProof(clientNonce: string): Promise<string> {
  const { privateKey, publicJwk, keyId } = await initServerIdentity();

  return new SignJWT({
    nonce: clientNonce,
    // Advisory only. A client cannot use this to detect a relay: the value is
    // whatever this server was configured with, and an impostor forwarding a
    // genuine proof passes it along unchanged. See the channel-binding note on
    // GRYT-51.
    host: process.env.EXTERNAL_HOST || undefined,
  })
    .setProtectedHeader({ alg: "ES256", kid: keyId, jwk: publicJwk })
    .setIssuer(keyId)
    .setIssuedAt()
    .setExpirationTime(`${PROOF_TTL_SECONDS}s`)
    .sign(privateKey);
}

export async function logServerIdentity(): Promise<void> {
  try {
    const keyId = await getServerKeyId();
    consola.success(`Server identity key ready (${keyId})`);
  } catch (err) {
    consola.error("Server identity initialization failed", err);
  }
}
