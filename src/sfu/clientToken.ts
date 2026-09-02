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

/**
 * Bumped only if the payload layout changes; the SFU refuses anything else.
 *
 * v2 adds a capability list. v1 is still minted nowhere but still verified by
 * the SFU, where it means every capability — the two services deploy
 * separately, so an SFU that read v1 as "grants nothing" would mute every
 * server that had not caught up yet. `internal/auth/clienttoken.go` carries the
 * same note from the other side.
 */
export const TOKEN_VERSION = "v1";
export const TOKEN_VERSION_2 = "v2";

/**
 * The capability to publish microphone audio.
 *
 * This is `speak` denied on a channel scope, carried to the place that can
 * actually enforce it. Audio does not pass through this server, so a check here
 * decides nothing on its own — the SFU drops the track, and it will only do
 * that if the token says to.
 *
 * Screen-share audio is not this. It is `share_screen`, it arrives on a
 * different transceiver, and the SFU tells them apart by which one.
 */
export const CAP_SPEAK = "speak";

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
  return `${TOKEN_VERSION}.${sealed(secret, payload)}`;
}

/**
 * A v2 token, which also says what the bearer may do.
 *
 * The capabilities are inside the signed payload rather than beside it, for the
 * same reason the room is: the client is the thing being restricted, so nothing
 * it can edit may be believed. Adding `speak` to a token that was minted
 * without it breaks the signature.
 */
export function signClientTokenV2(
  secret: string,
  userId: string,
  roomId: string,
  expiresAtMs: number,
  nonce: string,
  capabilities: readonly string[],
): string {
  const payload = `${userId}|${roomId}|${expiresAtMs}|${nonce}|${capabilities.join(",")}`;
  return `${TOKEN_VERSION_2}.${sealed(secret, payload)}`;
}

function sealed(secret: string, payload: string): string {
  const mac = createHmac("sha256", secret).update(payload).digest();
  return `${b64url(Buffer.from(payload, "utf8"))}.${b64url(mac)}`;
}

/** The same thing with a fresh nonce and the default lifetime. */
/**
 * Refuses an empty secret, because HMAC does not.
 *
 * This is the function that turns a secret into an entry ticket, so the check
 * belongs here rather than only at boot: a later caller that finds the secret
 * somewhere else gets the same refusal without anybody remembering to add it.
 *
 * Measured before it was written, against the SFU's own packages: a token
 * signed with "" is accepted by `auth.Verify` and walks `ValidateClientJoin`
 * into any room as any user id, holding `speak`. See GRYT-786.
 */
export function mintClientToken(
  secret: string,
  userId: string,
  roomId: string,
  capabilities: readonly string[],
  now = Date.now(),
): string {
  if (secret === "") {
    throw new Error(
      "Refusing to sign an SFU client token with an empty secret. See GRYT-786.",
    );
  }

  return signClientTokenV2(
    secret,
    userId,
    roomId,
    now + TOKEN_TTL_MS,
    randomBytes(12).toString("hex"),
    capabilities,
  );
}
