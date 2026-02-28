import { randomUUID } from "crypto";

import type { RefreshTokenRecord } from "../interfaces";
import { fromIso, getSqliteDb, toIso } from "./connection";

const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || "7", 10) || 7;

function rowToToken(r: Record<string, unknown>): RefreshTokenRecord {
  return {
    token_id: r.token_id as string,
    gryt_user_id: r.gryt_user_id as string,
    server_user_id: r.server_user_id as string,
    created_at: fromIso(r.created_at as string),
    expires_at: fromIso(r.expires_at as string),
    revoked: (r.revoked as number) === 1,
  };
}

export async function createRefreshToken(opts: {
  grytUserId: string;
  serverUserId: string;
}): Promise<RefreshTokenRecord> {
  const db = getSqliteDb();
  const tokenId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  db.prepare(
    `INSERT INTO refresh_tokens (token_id, gryt_user_id, server_user_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)`
  ).run(tokenId, opts.grytUserId, opts.serverUserId, toIso(now), toIso(expiresAt));

  return {
    token_id: tokenId,
    gryt_user_id: opts.grytUserId,
    server_user_id: opts.serverUserId,
    created_at: now,
    expires_at: expiresAt,
    revoked: false,
  };
}

export async function getRefreshToken(tokenId: string): Promise<RefreshTokenRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM refresh_tokens WHERE token_id = ?`).get(tokenId) as Record<string, unknown> | undefined;
  return row ? rowToToken(row) : null;
}

export async function revokeRefreshToken(tokenId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE token_id = ?`).run(tokenId);
}

export async function revokeUserRefreshTokens(grytUserId: string): Promise<{ revoked: number }> {
  const db = getSqliteDb();
  const result = db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE gryt_user_id = ? AND revoked = 0`).run(grytUserId);
  return { revoked: result.changes };
}
