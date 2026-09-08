/**
 * The format is fixed by `internal/auth/clienttoken.go` in the SFU and the two
 * must agree exactly. Both sides pin the same vector in their tests.
 */
import { createHmac, randomBytes } from "crypto";

/** v1 is minted nowhere and still verified as every capability: the services
    deploy separately, so "grants nothing" would mute whoever lagged. */
export const TOKEN_VERSION = "v1";
export const TOKEN_VERSION_2 = "v2";

/** Audio does not pass through this server, so the SFU dropping the track is
    the whole mechanism. Screen-share audio is `share_screen`. */
export const CAP_SPEAK = "speak";

/** Long enough for a slow WebRTC setup, short enough that a copied one is not
    worth keeping. */
export const TOKEN_TTL_MS = 5 * 60 * 1000;

function b64url(input: Buffer): string {
  return input.toString("base64url");
}

/** Room and user go inside the signed payload, so a token minted for one room
    cannot be replayed into another. */
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

/** Capabilities are inside the signed payload, so adding `speak` to a token
    minted without it breaks the signature. */
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

/** A fresh nonce and the default lifetime. Refuses an empty secret, because
    HMAC does not: a token signed with "" walks into any room as anybody. */
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
