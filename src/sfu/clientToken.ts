/**
 * Signs the token a client presents to the SFU when it joins a room.
 *
 * The SFU used to let a client in for knowing the server's shared password —
 * which this server handed to the browser so the browser could present it back,
 * so it was never a secret from anybody who had been in a call. Holding it was
 * enough to open a socket to the SFU directly, claim any user id, and enter any
 * room, which skipped the access checks made here.
 *
 * The client now carries something it cannot forge instead. The key is the same
 * shared secret this server registers with, so there is no new key to
 * distribute; what changes is that the secret stays between the two services.
 *
 * The format is fixed by `internal/auth/clienttoken.go` in the SFU and the two
 * have to agree exactly. `clientToken.test.ts` pins a vector that the Go tests
 * pin as well, so a change to either side that breaks the other fails a test
 * rather than a call.
 */
import { createHmac, randomBytes } from "crypto";

/** Bumped only if the payload layout changes; the SFU refuses anything else. */
export const TOKEN_VERSION = "v1";

/**
 * Long enough to survive a slow client finishing its WebRTC setup, short enough
 * that a token copied out of one is not worth keeping.
 */
export const TOKEN_TTL_MS = 5 * 60 * 1000;

function b64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * The room and user go inside the signed payload rather than beside it, so a
 * token minted for one room cannot be replayed into another — the SFU checks
 * what the payload claims against what the client asked for.
 */
export function signClientToken(
  secret: string,
  userId: string,
  roomId: string,
  expiresAtMs: number,
  nonce: string,
): string {
  const payload = `${userId}|${roomId}|${expiresAtMs}|${nonce}`;
  const mac = createHmac("sha256", secret).update(payload).digest();
  return `${TOKEN_VERSION}.${b64url(Buffer.from(payload, "utf8"))}.${b64url(mac)}`;
}

/** The same thing with a fresh nonce and the default lifetime. */
export function mintClientToken(secret: string, userId: string, roomId: string, now = Date.now()): string {
  return signClientToken(secret, userId, roomId, now + TOKEN_TTL_MS, randomBytes(12).toString("hex"));
}
