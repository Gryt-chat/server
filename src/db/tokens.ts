import { randomUUID } from "crypto";
import { getScyllaClient } from "./scylla";

const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || "7", 10) || 7;

export interface RefreshTokenRecord {
  token_id: string;
  gryt_user_id: string;
  server_user_id: string;
  created_at: Date;
  expires_at: Date;
  revoked: boolean;
}

export async function createRefreshToken(opts: {
  grytUserId: string;
  serverUserId: string;
}): Promise<RefreshTokenRecord> {
  const c = getScyllaClient();
  const tokenId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  await c.execute(
    `INSERT INTO server_refresh_tokens (token_id, gryt_user_id, server_user_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?)`,
    [tokenId, opts.grytUserId, opts.serverUserId, now, expiresAt, false],
    { prepare: true },
  );

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
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT token_id, gryt_user_id, server_user_id, created_at, expires_at, revoked FROM server_refresh_tokens WHERE token_id = ?`,
    [tokenId],
    { prepare: true },
  );
  const r = rs.first();
  if (!r) return null;
  return {
    token_id: r["token_id"],
    gryt_user_id: r["gryt_user_id"],
    server_user_id: r["server_user_id"],
    created_at: r["created_at"],
    expires_at: r["expires_at"],
    revoked: !!r["revoked"],
  };
}

export async function revokeRefreshToken(tokenId: string): Promise<void> {
  const c = getScyllaClient();
  await c.execute(
    `UPDATE server_refresh_tokens SET revoked = true WHERE token_id = ?`,
    [tokenId],
    { prepare: true },
  );
}

export async function revokeUserRefreshTokens(grytUserId: string): Promise<{ revoked: number }> {
  const c = getScyllaClient();
  const rs = await c.execute(
    `SELECT token_id FROM server_refresh_tokens WHERE gryt_user_id = ?`,
    [grytUserId],
    { prepare: true },
  );
  let revoked = 0;
  for (const row of rs.rows) {
    await c.execute(
      `UPDATE server_refresh_tokens SET revoked = true WHERE token_id = ?`,
      [row["token_id"]],
      { prepare: true },
    );
    revoked++;
  }
  return { revoked };
}
