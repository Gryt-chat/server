import jwt from 'jsonwebtoken';

const DEFAULT_SECRET = 'your-secret-key-change-in-production';

const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
if (JWT_SECRET === DEFAULT_SECRET && (process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('FATAL: JWT_SECRET is the default placeholder. Set a strong secret via JWT_SECRET env var before running in production.');
}

const ACCESS_TOKEN_EXPIRY = '15m';

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

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

export function getJwtSecret(): string {
  return JWT_SECRET;
}
