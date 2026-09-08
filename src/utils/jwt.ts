import jwt from 'jsonwebtoken';

const DEFAULT_SECRET = 'your-secret-key-change-in-production';

const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
if (JWT_SECRET === DEFAULT_SECRET && (process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('FATAL: JWT_SECRET is the default placeholder. Set a strong secret via JWT_SECRET env var before running in production.');
}

const ACCESS_TOKEN_EXPIRY = '15m';

/** Long because an `<img>` cannot notice a 401 and retry. Affordable because it
    reads files and nothing else, and `tokenVersion` kills them all. */
const FILE_TOKEN_EXPIRY = '12h';

export interface TokenPayload {
  grytUserId: string;
  serverUserId: string;
  nickname: string;
  serverHost: string;
  tokenVersion: number;
  /** The per-member counter, where `tokenVersion` above is server-wide. Read as
      0 when absent, so the deploy that added it signs nobody out. */
  userTokenVersion?: number;
}

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function verifyAccessToken(token: string, opts?: { ignoreExpiration?: boolean }): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: opts?.ignoreExpiration }) as TokenPayload & { scope?: string };
    // A file token shares this secret and would otherwise verify here. Any
    // scope, not `file` specifically, so a later one is refused by default.
    if (decoded?.scope) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Its own token because it rides in a URL, which turns up in logs and referrers.
 * `scope` is checked on the way back in, or this is an access token.
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
