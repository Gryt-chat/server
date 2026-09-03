import jwt from 'jsonwebtoken';

const DEFAULT_SECRET = 'your-secret-key-change-in-production';

const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
if (JWT_SECRET === DEFAULT_SECRET && (process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('FATAL: JWT_SECRET is the default placeholder. Set a strong secret via JWT_SECRET env var before running in production.');
}

const ACCESS_TOKEN_EXPIRY = '15m';

/**
 * Much longer than an access token, because nothing can refresh it mid-flight.
 *
 * A file token is carried in the query string of an `<img src>`, and an image
 * element has no way to notice a 401 and retry with a newer one — the picture
 * just fails. Fifteen minutes would mean every avatar on screen breaking a
 * quarter of an hour into a session.
 *
 * It is a far weaker credential than the access token, which is what makes the
 * longer life affordable: it reads files on one server and does nothing else.
 * It is re-minted whenever the access token is, and it carries `tokenVersion`,
 * so bumping that on the server kills every one already handed out.
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
 * The token that reads a file, and only that.
 *
 * `GET /api/uploads/files/:fileId` had no auth at all: every file ever uploaded
 * to any channel or DM was one request away from anyone holding the UUID,
 * forever and with no way to revoke it. Ids travel inside message payloads, so
 * a former member's client cache was a permanent key and so was any forwarded
 * message. Gating uploads behind a role decided nothing while the read side was
 * open. See GRYT-740.
 *
 * It is its own token rather than the access token because of where it has to
 * go. An `<img>` element cannot send an Authorization header, so the credential
 * has to sit in the URL — and a URL turns up in logs, in a referrer, and in
 * whatever somebody pastes into a chat. What leaks here reads files on one
 * server until it expires. The access token would be the whole session.
 *
 * `scope` is checked on the way back in. Without it this is byte-identical to
 * an access token signed with the same secret, and the point is that the two
 * are not interchangeable.
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
