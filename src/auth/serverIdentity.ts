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

// The server proving who it is, never a user: this key signs no certificate.
// Separate from `server_id`, which is a discovery hint and not a credential.

interface ServerIdentity {
  privateKey: CryptoKey | Uint8Array;
  publicJwk: JWK;
  keyId: string;
  /** Each is signed by a key this server used to hold and names its replacement,
      so a client pinned to an older one can follow the chain forward. */
  vouches: string[];
}

interface StoredIdentity {
  publicJwk: JWK;
  privateJwk: JWK;
  vouches?: string[];
}

const PROOF_TTL_SECONDS = 60;

/** Long, because its job is to let a client offline during the rotation catch
    up. Not unlimited: it bounds how long a leaked old key redirects trust. */
const VOUCH_TTL = "180d";

/** Guards against a malformed file turning into an unbounded walk. */
const MAX_VOUCH_CHAIN = 16;

// index.ts initialises fire-and-forget, so a join can arrive before startup has
// finished. Memoized, so every caller waits on the first one's work.
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

  let vouches: string[] = [];

  if (existsSync(kp)) {
    const stored = JSON.parse(readFileSync(kp, "utf-8")) as StoredIdentity;
    publicJwk = stored.publicJwk;
    privateKey = await importJWK(stored.privateJwk, "ES256");
    // Absent on files written before GRYT-54, which is why it is optional.
    vouches = Array.isArray(stored.vouches) ? stored.vouches.slice(-MAX_VOUCH_CHAIN) : [];
  } else {
    const kp2 = await generateKeyPair("ES256", { extractable: true });
    privateKey = kp2.privateKey;
    publicJwk = await exportJWK(kp2.publicKey);
    const privateJwk = await exportJWK(kp2.privateKey);

    // 0600: another user on the box reading this can impersonate the server to
    // every client that has pinned it.
    writeFileSync(kp, JSON.stringify({ publicJwk, privateJwk }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  publicJwk.use = "sig";
  publicJwk.alg = "ES256";

  // The thumbprint is what a client pins and files the server under, and it
  // survives the host and port changing.
  const keyId = await calculateJwkThumbprint(publicJwk, "sha256");
  publicJwk.kid = keyId;

  return { privateKey, publicJwk, keyId, vouches };
}

/** Deliberate rotation only: anybody holding the retired key can sign the same
    statement, so a compromised key needs clients re-verified by hand. */
export async function rotateServerIdentity(): Promise<{ from: string; to: string }> {
  const current = await initServerIdentity();

  const next = await generateKeyPair("ES256", { extractable: true });
  const nextPublicJwk = await exportJWK(next.publicKey);
  nextPublicJwk.use = "sig";
  nextPublicJwk.alg = "ES256";
  const nextKeyId = await calculateJwkThumbprint(nextPublicJwk, "sha256");
  nextPublicJwk.kid = nextKeyId;

  // Signed by the OUTGOING key. That is what lets a client which only knows the
  // old key decide the new one is legitimate.
  const vouch = await new SignJWT({ prev: current.keyId, next: nextKeyId, jwk: nextPublicJwk })
    .setProtectedHeader({ alg: "ES256", kid: current.keyId, jwk: current.publicJwk })
    .setIssuer(current.keyId)
    .setSubject(nextKeyId)
    .setIssuedAt()
    .setExpirationTime(VOUCH_TTL)
    .sign(current.privateKey);

  const vouches = [...current.vouches, vouch].slice(-MAX_VOUCH_CHAIN);
  const privateJwk = await exportJWK(next.privateKey);

  writeFileSync(
    keyPath(),
    JSON.stringify({ publicJwk: nextPublicJwk, privateJwk, vouches } satisfies StoredIdentity, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );

  // Drop the memoized identity so the next caller picks up the new key.
  identityPromise = null;

  return { from: current.keyId, to: nextKeyId };
}

/** Succession statements to hand a client alongside the proof, oldest first. */
export async function getVouchChain(): Promise<string[]> {
  return (await initServerIdentity()).vouches;
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

/** The embedded public key gives a first-time client something to pin and proves
    nothing on its own: an impostor can produce an equally valid one. */
export async function signServerProof(clientNonce: string): Promise<string> {
  const { privateKey, publicJwk, keyId } = await initServerIdentity();

  return new SignJWT({
    nonce: clientNonce,
    // Advisory only: an impostor forwarding a genuine proof passes this along
    // unchanged, so it cannot detect a relay.
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
