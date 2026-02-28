import { randomUUID } from "crypto";

import type { UserRecord } from "../interfaces";
import { fromIso, getSqliteDb, intToBool, toIso } from "./connection";
import { getServerConfig, setServerOwner } from "./servers";
import { revokeUserRefreshTokens } from "./tokens";

function rowToUser(r: Record<string, unknown>): UserRecord {
  return {
    gryt_user_id: r.gryt_user_id as string,
    server_user_id: r.server_user_id as string,
    nickname: r.nickname as string,
    avatar_file_id: (r.avatar_file_id as string) || undefined,
    joined_with_invite_code: (r.joined_with_invite_code as string) || undefined,
    created_at: fromIso(r.created_at as string),
    last_seen: fromIso(r.last_seen as string),
    is_active: intToBool(r.is_active as number),
  };
}

export async function upsertUser(
  grytUserId: string,
  nickname: string,
  opts?: { avatarFileId?: string; inviteCode?: string },
): Promise<UserRecord> {
  const db = getSqliteDb();
  const now = new Date();
  const existing = await getUserByGrytId(grytUserId);

  if (existing) {
    const newAvatar = opts?.avatarFileId ?? existing.avatar_file_id ?? null;
    db.prepare(
      `UPDATE users SET nickname = ?, avatar_file_id = ?, last_seen = ?, is_active = 1 WHERE gryt_user_id = ?`
    ).run(nickname, newAvatar, toIso(now), grytUserId);
    return {
      ...existing,
      nickname,
      avatar_file_id: newAvatar || undefined,
      last_seen: now,
      is_active: true,
    };
  }

  const serverUserId = `user_${randomUUID()}`;
  db.prepare(
    `INSERT INTO users (gryt_user_id, server_user_id, nickname, avatar_file_id, joined_with_invite_code, is_active, created_at, last_seen) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(grytUserId, serverUserId, nickname, opts?.avatarFileId ?? null, opts?.inviteCode ?? null, toIso(now), toIso(now));

  return {
    gryt_user_id: grytUserId,
    server_user_id: serverUserId,
    nickname,
    avatar_file_id: opts?.avatarFileId,
    joined_with_invite_code: opts?.inviteCode,
    created_at: now,
    last_seen: now,
    is_active: true,
  };
}

export async function getUserByGrytId(grytUserId: string): Promise<UserRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM users WHERE gryt_user_id = ?`).get(grytUserId) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export async function getUserByServerId(serverUserId: string): Promise<UserRecord | null> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT * FROM users WHERE server_user_id = ?`).get(serverUserId) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export async function verifyUserIdentity(serverUserId: string, claimedGrytUserId: string): Promise<boolean> {
  const user = await getUserByServerId(serverUserId);
  if (!user) return false;
  return user.gryt_user_id === claimedGrytUserId;
}

export async function getAllRegisteredUsers(): Promise<UserRecord[]> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT * FROM users`).all() as Record<string, unknown>[];
  return rows.map(rowToUser);
}

export async function getRegisteredUserCount(): Promise<number> {
  const db = getSqliteDb();
  const row = db.prepare(`SELECT COUNT(*) as count FROM users`).get() as { count: number };
  return row.count;
}

export async function updateUserNickname(serverUserId: string, nickname: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE users SET nickname = ? WHERE server_user_id = ?`).run(nickname, serverUserId);
}

export async function updateUserAvatar(serverUserId: string, avatarFileId: string): Promise<void> {
  return setUserAvatar(serverUserId, avatarFileId);
}

export async function setUserAvatar(serverUserId: string, avatarFileId: string | null): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE users SET avatar_file_id = ? WHERE server_user_id = ?`).run(avatarFileId, serverUserId);
}

export async function getUsersByServerIds(ids: string[]): Promise<Map<string, { nickname: string; avatar_file_id?: string }>> {
  const result = new Map<string, { nickname: string; avatar_file_id?: string }>();
  if (ids.length === 0) return result;
  const db = getSqliteDb();
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db.prepare(`SELECT server_user_id, nickname, avatar_file_id FROM users WHERE server_user_id IN (${placeholders})`).all(...unique) as Record<string, unknown>[];
  for (const r of rows) {
    result.set(r.server_user_id as string, {
      nickname: (r.nickname as string) ?? "Unknown",
      avatar_file_id: (r.avatar_file_id as string) || undefined,
    });
  }
  return result;
}

export async function getAllAvatarFileIds(): Promise<Set<string>> {
  const db = getSqliteDb();
  const rows = db.prepare(`SELECT avatar_file_id FROM users WHERE avatar_file_id IS NOT NULL`).all() as { avatar_file_id: string }[];
  return new Set(rows.map((r) => r.avatar_file_id));
}

export async function setUserInactive(serverUserId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE users SET is_active = 0 WHERE server_user_id = ?`).run(serverUserId);
}

export async function replaceUserIdentity(
  serverUserId: string,
  newGrytUserId: string,
): Promise<{ oldGrytUserId: string; ownerUpdated: boolean }> {
  const db = getSqliteDb();
  const oldUser = await getUserByServerId(serverUserId);
  if (!oldUser) throw new Error("Target user not found on this server.");
  const oldGrytUserId = oldUser.gryt_user_id;
  if (oldGrytUserId === newGrytUserId) throw new Error("New identity is the same as the current one.");
  const existing = await getUserByGrytId(newGrytUserId);
  if (existing) throw new Error("New identity already belongs to another user on this server.");

  db.prepare(`UPDATE users SET gryt_user_id = ? WHERE server_user_id = ?`).run(newGrytUserId, serverUserId);

  let ownerUpdated = false;
  const cfg = await getServerConfig();
  if (cfg?.owner_gryt_user_id === oldGrytUserId) {
    await setServerOwner(newGrytUserId);
    ownerUpdated = true;
  }
  await revokeUserRefreshTokens(oldGrytUserId).catch(() => {});
  return { oldGrytUserId, ownerUpdated };
}
