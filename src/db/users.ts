import { types } from "cassandra-driver";
import { randomUUID } from "crypto";

import { getScyllaClient } from "./scylla";

export interface UserRecord {
  gryt_user_id: string; // Internal Gryt Auth user ID (never exposed)
  server_user_id: string; // Secret server user ID (never exposed to clients)
  nickname: string;
  avatar_file_id?: string; // file_id referencing files_by_id for avatar image
  joined_with_invite_code?: string; // invite code used on first join (for leak tracking)
  created_at: Date;
  last_seen: Date;
  last_token_refresh?: Date; // Track when token was last refreshed
  is_active: boolean; // Whether the user is currently active on the server
}

function rowToUserRecord(r: types.Row): UserRecord {
  return {
    gryt_user_id: r["gryt_user_id"],
    server_user_id: r["server_user_id"],
    nickname: r["nickname"],
    avatar_file_id: r["avatar_file_id"] ?? undefined,
    joined_with_invite_code: r["joined_with_invite_code"] ?? undefined,
    created_at: r["created_at"],
    last_seen: r["last_seen"],
    is_active: typeof r["is_active"] === "boolean" ? r["is_active"] : true,
  };
}


export async function upsertUser(
  grytUserId: string,
  nickname: string,
  opts?: { avatarFileId?: string; inviteCode?: string },
): Promise<UserRecord> {
  const c = getScyllaClient();
  const now = new Date();

  try {
    const existingUser = await getUserByGrytId(grytUserId);

    if (existingUser) {
      const newAvatar = opts?.avatarFileId ?? existingUser.avatar_file_id;
      await c.execute(
        `UPDATE users_by_gryt_id SET nickname = ?, avatar_file_id = ?, last_seen = ?, is_active = ? WHERE gryt_user_id = ?`,
        [nickname, newAvatar ?? null, now, true, grytUserId],
        { prepare: true }
      );
      
      await c.execute(
        `UPDATE users_by_server_id SET nickname = ?, avatar_file_id = ?, last_seen = ?, is_active = ? WHERE server_user_id = ?`,
        [nickname, newAvatar ?? null, now, true, existingUser.server_user_id],
        { prepare: true }
      );

      return {
        gryt_user_id: grytUserId, 
        server_user_id: existingUser.server_user_id, 
        nickname,
        avatar_file_id: newAvatar,
        joined_with_invite_code: existingUser.joined_with_invite_code,
        created_at: existingUser.created_at, 
        last_seen: now,
        is_active: true
      };
    } else {
      const serverUserId = `user_${randomUUID()}`;
      const inviteCode = opts?.inviteCode ?? null;
      const avatarFileId = opts?.avatarFileId ?? null;

      await c.execute(
        `INSERT INTO users_by_gryt_id (gryt_user_id, server_user_id, nickname, avatar_file_id, joined_with_invite_code, created_at, last_seen, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [grytUserId, serverUserId, nickname, avatarFileId, inviteCode, now, now, true],
        { prepare: true }
      );
      
      await c.execute(
        `INSERT INTO users_by_server_id (server_user_id, gryt_user_id, nickname, avatar_file_id, joined_with_invite_code, created_at, last_seen, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [serverUserId, grytUserId, nickname, avatarFileId, inviteCode, now, now, true],
        { prepare: true }
      );

      return { 
        gryt_user_id: grytUserId, 
        server_user_id: serverUserId, 
        nickname,
        avatar_file_id: avatarFileId ?? undefined,
        joined_with_invite_code: inviteCode ?? undefined,
        created_at: now, 
        last_seen: now,
        is_active: true
      };
    }
  } catch (error) {
    console.error(`❌ Failed to upsert user:`, error);
    throw error;
  }
}

export async function getUserByGrytId(grytUserId: string): Promise<UserRecord | null> {
  const c = getScyllaClient();
  
  try {
    const rs = await c.execute(
      `SELECT gryt_user_id, server_user_id, nickname, avatar_file_id, created_at, last_seen, is_active FROM users_by_gryt_id WHERE gryt_user_id = ?`,
      [grytUserId],
      { prepare: true }
    );
    const r = rs.first();
    if (r) return rowToUserRecord(r);
    return null;
  } catch (error) {
    console.error(`❌ Failed to get user by Gryt ID:`, error);
    throw error;
  }
}

export async function getUserByServerId(serverUserId: string): Promise<UserRecord | null> {
  const c = getScyllaClient();
  
  try {
    const rs = await c.execute(
      `SELECT server_user_id, gryt_user_id, nickname, avatar_file_id, created_at, last_seen, is_active FROM users_by_server_id WHERE server_user_id = ?`,
      [serverUserId],
      { prepare: true }
    );
    const r = rs.first();
    if (r) return rowToUserRecord(r);
    return null;
  } catch (error) {
    console.error(`❌ Failed to get user by server ID:`, error);
    throw error;
  }
}

export async function verifyUserIdentity(serverUserId: string, claimedGrytUserId: string): Promise<boolean> {
  const c = getScyllaClient();
  
  try {
    const rs = await c.execute(
      `SELECT gryt_user_id FROM users_by_server_id WHERE server_user_id = ?`,
      [serverUserId],
      { prepare: true }
    );
    const r = rs.first();
    
    if (!r) {
      console.warn(`⚠️ No user found for serverUserId: ${serverUserId}`);
      return false;
    }
    
    const actualGrytUserId = r["gryt_user_id"] as string;
    const isValid = actualGrytUserId === claimedGrytUserId;
    return isValid;
  } catch (error) {
    console.error(`❌ Failed to verify user identity:`, error);
    return false;
  }
}

export async function getAllRegisteredUsers(): Promise<UserRecord[]> {
  const c = getScyllaClient();
  
  try {
    const rs = await c.execute(
      `SELECT server_user_id, gryt_user_id, nickname, avatar_file_id, created_at, last_seen, is_active FROM users_by_server_id`,
      [],
      { prepare: true }
    );
    
    const users = rs.rows.map((r) => ({
      gryt_user_id: r["gryt_user_id"],
      server_user_id: r["server_user_id"],
      nickname: r["nickname"],
      avatar_file_id: r["avatar_file_id"] ?? undefined,
      created_at: r["created_at"],
      last_seen: r["last_seen"],
      is_active: typeof r["is_active"] === "boolean" ? r["is_active"] : true, // Default to true for backward compatibility
    }));
    return users;
  } catch (error) {
    console.error(`❌ Failed to get all registered users:`, error);
    throw error;
  }
}

export async function updateUserNickname(serverUserId: string, nickname: string): Promise<void> {
  const c = getScyllaClient();
  try {
    await c.execute(
      `UPDATE users_by_server_id SET nickname = ? WHERE server_user_id = ?`,
      [nickname, serverUserId],
      { prepare: true }
    );
    const user = await getUserByServerId(serverUserId);
    if (user) {
      await c.execute(
        `UPDATE users_by_gryt_id SET nickname = ? WHERE gryt_user_id = ?`,
        [nickname, user.gryt_user_id],
        { prepare: true }
      );
    }
  } catch (error) {
    console.error(`❌ Failed to update nickname:`, error);
    throw error;
  }
}

export async function updateUserAvatar(serverUserId: string, avatarFileId: string): Promise<void> {
  return setUserAvatar(serverUserId, avatarFileId);
}

export async function setUserAvatar(serverUserId: string, avatarFileId: string | null): Promise<void> {
  const c = getScyllaClient();
  try {
    await c.execute(
      `UPDATE users_by_server_id SET avatar_file_id = ? WHERE server_user_id = ?`,
      [avatarFileId, serverUserId],
      { prepare: true }
    );
    const user = await getUserByServerId(serverUserId);
    if (user) {
      await c.execute(
        `UPDATE users_by_gryt_id SET avatar_file_id = ? WHERE gryt_user_id = ?`,
        [avatarFileId, user.gryt_user_id],
        { prepare: true }
      );
    }
  } catch (error) {
    console.error(`❌ Failed to update avatar:`, error);
    throw error;
  }
}

export async function getUsersByServerIds(ids: string[]): Promise<Map<string, { nickname: string; avatar_file_id?: string }>> {
  const result = new Map<string, { nickname: string; avatar_file_id?: string }>();
  if (ids.length === 0) return result;

  const c = getScyllaClient();
  const unique = [...new Set(ids)];

  const promises = unique.map(async (id) => {
    try {
      const rs = await c.execute(
        `SELECT server_user_id, nickname, avatar_file_id FROM users_by_server_id WHERE server_user_id = ?`,
        [id],
        { prepare: true }
      );
      const r = rs.first();
      if (r) {
        result.set(id, {
          nickname: r["nickname"] ?? "Unknown",
          avatar_file_id: r["avatar_file_id"] ?? undefined,
        });
      }
    } catch {
      // Skip failed lookups
    }
  });

  await Promise.all(promises);
  return result;
}

export async function getAllAvatarFileIds(): Promise<Set<string>> {
  const c = getScyllaClient();
  const ids = new Set<string>();
  const rs = await c.execute(
    `SELECT avatar_file_id FROM users_by_server_id`,
    [],
    { prepare: true },
  );
  for (const row of rs.rows) {
    const avatarId = row["avatar_file_id"];
    if (avatarId) ids.add(String(avatarId));
  }
  return ids;
}

export async function setUserInactive(serverUserId: string): Promise<void> {
  const c = getScyllaClient();

  try {
    await c.execute(
      `UPDATE users_by_server_id SET is_active = ? WHERE server_user_id = ?`,
      [false, serverUserId],
      { prepare: true }
    );
    
    const user = await getUserByServerId(serverUserId);
    if (user) {
      await c.execute(
        `UPDATE users_by_gryt_id SET is_active = ? WHERE gryt_user_id = ?`,
        [false, user.gryt_user_id],
        { prepare: true }
      );
    }
  } catch (error) {
    console.error(`❌ Failed to set user as inactive:`, error);
    throw error;
  }
}
