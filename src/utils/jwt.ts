import jwt from 'jsonwebtoken';

const DEFAULT_SECRET = 'your-secret-key-change-in-production';

const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
if (JWT_SECRET === DEFAULT_SECRET && (process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('FATAL: JWT_SECRET is the default placeholder. Set a strong secret via JWT_SECRET env var before running in production.');
}

const ACCESS_TOKEN_EXPIRY = '15m';

/**
 * Much longer than an access token, because an `<img>` cannot notice a 401 and
 * retry — the picture just fails. Affordable because it reads files on one
 * server and does nothing else, and it carries `tokenVersion`, so bumping that
 * kills every one already handed out.
 */
const FILE_TOKEN_EXPIRY = '12h';

export interface TokenPayload {
  grytUserId: string;
  serverUserId: string;
  nickname: string;
  serverHost: string;
  tokenVersion: number;
}

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function verifyAccessToken(token: string, opts?: { ignoreExpiration?: boolean }): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: opts?.ignoreExpiration }) as TokenPayload & { scope?: string };
    // A file token is signed with this same secret and would otherwise verify
    // here — which would make the weaker credential, the one that travels in
    // URLs and logs, work everywhere the stronger one does. The check is for
    // any scope rather than for `file` specifically, so a scope added later is
    // refused by default instead of being quietly accepted.
    if (decoded?.scope) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * The token that reads a file, and only that. `GET /api/uploads/files/:fileId`
 * had no auth at all, so every file was one request away from anyone holding
 * the UUID, forever (GRYT-740).
 *
 * Its own token because an `<img>` cannot send an Authorization header, so it
 * sits in the URL — which turns up in logs, referrers and pasted links. What
 * leaks reads files on one server; the access token would be the session.
 *
 * **`scope` is checked on the way back in.** Without it this is byte-identical
 * to an access token signed with the same secret.
 */
export interface FileTokenPayload extends TokenPayload {
  scope: 'file';
}

export function generateFileToken(payload: TokenPayload): string {
  return jwt.sign({ ...payload, scope: 'file' }, JWT_SECRET, { expiresIn: FILE_TOKEN_EXPIRY });
}

export function verifyFileToken(token: string): FileTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as FileTokenPayload;
    // An access token would verify here too, and must not. The scope is the
    // only thing separating "may read files" from "may do anything".
    return decoded?.scope === 'file' ? decoded : null;
  } catch {
    return null;
  }
}

export function getJwtSecret(): string {
  return JWT_SECRET;
}
