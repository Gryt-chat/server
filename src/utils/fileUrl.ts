import { createHmac, timingSafeEqual } from "node:crypto";

import { getJwtSecret, type TokenPayload } from "./jwt";

/**
 * Signed file URLs (GRYT-1549). The client gets a signing key over the socket and signs
 * each URL itself, so a leaked URL reads one file for a few minutes and carries no token.
 */

/** Same as the file token it replaces, and renewed with every access token. */
const KEY_LIFETIME_S = 12 * 60 * 60;

/** The furthest ahead a URL may expire. Clients sign in five-minute steps, two steps out. */
export const MAX_URL_LIFETIME_S = 10 * 60;

/** Slack for the client's clock estimate, which is off by at least the socket's latency. */
const CLOCK_SLACK_S = 60;

/** Sent with `server:joined` and `token:refreshed`. `now` lets the client correct its clock. */
export interface FileUrlKey {
  key: string;
  user: string;
  until: number;
  now: number;
}

export interface SignedFileUrl {
  user: string;
  until: number;
  expires: number;
  sig: string;
}

// Its own secret, so a file URL key can never be confused with a JWT signature.
function rootSecret(): Buffer {
  return createHmac("sha256", getJwtSecret()).update("gryt-file-url-secret").digest();
}

interface KeyInputs {
  serverHost: string;
  serverUserId: string;
  tokenVersion: number;
  userTokenVersion: number;
  until: number;
}

// Either version counter moving changes the key, which kills every URL signed with it.
function deriveKey(k: KeyInputs): Buffer {
  return createHmac("sha256", rootSecret())
    .update(["file-url-key", "v1", k.serverHost, k.serverUserId, k.tokenVersion, k.userTokenVersion, k.until].join("\n"))
    .digest();
}

export function fileUrlMessage(fileId: string, thumb: boolean, expires: number): string {
  return ["file-url", fileId, thumb ? "thumb" : "full", String(expires)].join("\n");
}

export function signFileUrl(key: Buffer, fileId: string, thumb: boolean, expires: number): string {
  return createHmac("sha256", key).update(fileUrlMessage(fileId, thumb, expires)).digest("base64url");
}

export function generateFileUrlKey(payload: TokenPayload, nowMs = Date.now()): FileUrlKey {
  const until = Math.floor(nowMs / 1000) + KEY_LIFETIME_S;
  const key = deriveKey({
    serverHost: payload.serverHost,
    serverUserId: payload.serverUserId,
    tokenVersion: payload.tokenVersion ?? 0,
    userTokenVersion: payload.userTokenVersion ?? 0,
    until,
  });
  return { key: key.toString("base64url"), user: payload.serverUserId, until, now: nowMs };
}

const INT = /^\d{1,12}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;

/** The signed parameters, or null when the URL has none (or they are malformed). */
export function readSignedFileUrl(query: Record<string, unknown>): SignedFileUrl | null {
  const { u, k, e, s } = query;
  if (typeof u !== "string" || typeof k !== "string" || typeof e !== "string" || typeof s !== "string") return null;
  if (!u || u.length > 200 || !INT.test(k) || !INT.test(e) || !SIG.test(s)) return null;
  return { user: u, until: Number(k), expires: Number(e), sig: s };
}

export interface SignedFileUrlCheck {
  fileId: string;
  thumb: boolean;
  serverHost: string;
  tokenVersion: number;
  userTokenVersion: number;
  nowMs?: number;
}

/** True when `signed` was made with this member's current key, for this file, and has not expired. */
export function checkSignedFileUrl(signed: SignedFileUrl, c: SignedFileUrlCheck): boolean {
  const now = Math.floor((c.nowMs ?? Date.now()) / 1000);
  if (signed.expires < now || signed.until < now) return false;
  if (signed.expires > now + MAX_URL_LIFETIME_S + CLOCK_SLACK_S) return false;

  const key = deriveKey({
    serverHost: c.serverHost,
    serverUserId: signed.user,
    tokenVersion: c.tokenVersion,
    userTokenVersion: c.userTokenVersion,
    until: signed.until,
  });
  const expected = Buffer.from(signFileUrl(key, c.fileId, c.thumb, signed.expires));
  const given = Buffer.from(signed.sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
