/**
 * Signs the token a client presents to the SFU when it joins a room. The SFU
 * used to admit anybody holding the shared password — which this server handed
 * to the browser, so it was never a secret from anybody who had been in a call,
 * and holding it meant any user id in any room.
 *
 * **The format is fixed by `internal/auth/clienttoken.go` in the SFU and the
 * two have to agree exactly.** `clientToken.test.ts` pins a vector the Go tests
 * pin as well, so breaking either side fails a test rather than a call.
 */
import { createHmac, randomBytes } from "crypto";

/**
 * Bumped only if the payload layout changes; the SFU refuses anything else. v1
 * is minted nowhere and still verified, where it means every capability — the
 * services deploy separately, so reading it as "grants nothing" would mute
 * every server that had not caught up.
 */
export const TOKEN_VERSION = "v1";
export const TOKEN_VERSION_2 = "v2";

/**
 * Publish microphone audio. Audio does not pass through this server, so a check
 * here decides nothing on its own — the SFU drops the track only if the token
 * says to. Screen-share audio is `share_screen`, on a different transceiver.
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
 * A v2 token, which also says what the bearer may do. Capabilities are inside
 * the signed payload — the client is the thing being restricted, so adding
 * `speak` to a token minted without it breaks the signature.
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
 * Refuses an empty secret, because HMAC does not. Here rather than only at
 * boot, so a later caller that finds the secret elsewhere gets the same
 * refusal. A token signed with "" walks into any room as any user id holding
 * `speak` — measured against the SFU's own packages (GRYT-786).
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
