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
// same server the client joined before (GRYT-51). This is the server proving
// who *it* is, and has nothing to do with the certificates users present to
// prove who *they* are — those are verified in `identity.ts` and this key never
// signs one.
//
// It is also separate from `server_id`, which goes out unauthenticated over
// mDNS and is a discovery hint, never a credential.

interface ServerIdentity {
  privateKey: CryptoKey | Uint8Array;
  publicJwk: JWK;
  keyId: string;
  /**
   * Succession statements, oldest first. Each is a JWT signed by a key this
   * server used to hold, naming the key that replaced it, so a client pinned to
   * an older key can follow the chain forward instead of treating the change as
   * an impersonation attempt (GRYT-54).
   */
  vouches: string[];
}

interface StoredIdentity {
  publicJwk: JWK;
  privateJwk: JWK;
  vouches?: string[];
}

const PROOF_TTL_SECONDS = 60;

/**
 * How long a succession statement stays usable.
 *
 * Long, because its whole job is to let a client that was offline during the
 * rotation catch up — a short window would send exactly those users to the
 * manual unblock path this exists to avoid. Not unlimited, because it bounds
 * how long a leaked old key can be used to redirect trust.
 */
const VOUCH_TTL = "180d";

/** Guards against a malformed file turning into an unbounded walk. */
const MAX_VOUCH_CHAIN = 16;

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

  return { privateKey, publicJwk, keyId, vouches };
}

/**
 * Replace this server's identity key, leaving a statement signed by the outgoing
 * key that names its replacement (GRYT-54).
 *
 * **Deliberate rotation only.** Anyone holding the retired key can sign such a
 * statement too, so rotating away from a compromised key does not lock the
 * holder out — clients pinned to it have to be re-verified by hand.
 */
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

/**
 * Sign a proof of possession of the server identity key, bound to a nonce the
 * client chose for this connection.
 *
 * The public key travels in the protected header so a first-time client has
 * something to pin. **That embedded key proves nothing on its own** — the JWT
 * is self-signed and an impostor can produce an equally valid one. It means
 * something only once the client has a pinned key to check against.
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
