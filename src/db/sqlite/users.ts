import { randomUUID } from "crypto";

import type { UserRecord } from "../interfaces";
import { fromIso, getSqliteDb, intToBool, toIso, type SQLInputValue } from "./connection";
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
    token_version: Number(r.token_version ?? 0),
    is_server_muted: intToBool(r.is_server_muted as number),
    is_server_deafened: intToBool(r.is_server_deafened as number),
    server_mute_expires_at: r.server_mute_expires_at
      ? fromIso(r.server_mute_expires_at as string)
      : null,
    nickname_change_count: Number(r.nickname_change_count ?? 0),
    nickname_changed_at: r.nickname_changed_at
      ? fromIso(r.nickname_changed_at as string)
      : null,
    avatar_worn: (r.avatar_worn as string) || null,
    dm_key_binding: (r.dm_key_binding as string) || null,
  };
}

/** An expired mute reads as unmuted, like an expired ban. The row is left alone:
    this runs on every admission, and a write here turns a storm into a storm. */
export function effectiveModerationState(user: UserRecord): {
  isServerMuted: boolean;
  isServerDeafened: boolean;
} {
  const muteExpired =
    !!user.server_mute_expires_at && user.server_mute_expires_at.getTime() <= Date.now();
  return {
    isServerMuted: user.is_server_muted && !muteExpired,
    isServerDeafened: user.is_server_deafened,
  };
}

/** Only the fields passed are written, so muting does not clear a deafen.
    `mutedUntil: null` with `muted: true` is indefinite; a date is a timeout. */
export async function setUserModerationState(
  serverUserId: string,
  state: { muted?: boolean; deafened?: boolean; mutedUntil?: Date | null },
): Promise<void> {
  const db = getSqliteDb();
  const sets: string[] = [];
  const params: SQLInputValue[] = [];

  if (state.muted !== undefined) {
    sets.push("is_server_muted = ?");
    params.push(state.muted ? 1 : 0);
    // An unmute clears any timeout with it, so a later manual mute does not
    // inherit an expiry the moderator never asked for.
    sets.push("server_mute_expires_at = ?");
    params.push(state.muted && state.mutedUntil ? toIso(state.mutedUntil) : null);
  } else if (state.mutedUntil !== undefined) {
    sets.push("server_mute_expires_at = ?");
    params.push(state.mutedUntil ? toIso(state.mutedUntil) : null);
  }

  if (state.deafened !== undefined) {
    sets.push("is_server_deafened = ?");
    params.push(state.deafened ? 1 : 0);
  }

  if (sets.length === 0) return;

  params.push(serverUserId);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE server_user_id = ?`).run(...params);
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

    // The stored nickname wins on a rejoin: a client with none sends the literal
    // "Unknown", so overwriting renamed people on every server they had joined.
    db.prepare(
      `UPDATE users SET avatar_file_id = ?, last_seen = ?, is_active = 1 WHERE gryt_user_id = ?`
    ).run(newAvatar, toIso(now), grytUserId);
    return {
      ...existing,
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
    is_server_muted: false,
    is_server_deafened: false,
    server_mute_expires_at: null,
    // Matches the column default. A member who has just joined has nothing to
    // revoke, and the token minted for this join carries the same zero.
    token_version: 0,
    nickname_change_count: 0,
    nickname_changed_at: null,
    // A new member has not designed anything yet, so their owl is whatever
    // their name draws.
    avatar_worn: null,
    // Sent after joining, if at all. A client older than GRYT-720 never sends
    // one, and a member with no binding simply has no encrypted messages.
    dm_key_binding: null,
  };
}

/** Not parsed, verified or trusted. Last write wins: a changed seed makes every
    peer who pinned the old key refuse it, which is the feature. */
export async function setUserDmKeyBinding(
  serverUserId: string,
  binding: string | null,
): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE users SET dm_key_binding = ? WHERE server_user_id = ?`).run(
    binding,
    serverUserId,
  );
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

/** Counted only when the name changes: the client sends `profile:update` for
    other things, and the member list shows this count as suspicion. */
export async function updateUserNickname(serverUserId: string, nickname: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare(
    `UPDATE users
        SET nickname = ?,
            nickname_change_count = nickname_change_count + 1,
            nickname_changed_at = ?
      WHERE server_user_id = ? AND nickname <> ?`
  ).run(nickname, toIso(new Date()), serverUserId, nickname);
}

export async function updateUserAvatar(serverUserId: string, avatarFileId: string): Promise<void> {
  return setUserAvatar(serverUserId, avatarFileId);
}

export async function setUserAvatar(serverUserId: string, avatarFileId: string | null): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE users SET avatar_file_id = ? WHERE server_user_id = ?`).run(avatarFileId, serverUserId);
}

/** Not folded into `setUserAvatar`: designing an owl uploads a picture too, so
    an upload cannot mean somebody stopped using a designed look. */
export async function setUserWorn(serverUserId: string, worn: string | null): Promise<void> {
  const db = getSqliteDb();
  db.prepare(`UPDATE users SET avatar_worn = ? WHERE server_user_id = ?`).run(worn, serverUserId);
}

/** Carries `gryt_user_id` only so a caller can read the bot prefix off it. The
    id itself is never sent to a client, so derive the flag and pass that. */
export async function getUsersByServerIds(ids: string[]): Promise<Map<string, { nickname: string; avatar_file_id?: string; avatar_worn: string | null; gryt_user_id: string }>> {
  const result = new Map<string, { nickname: string; avatar_file_id?: string; avatar_worn: string | null; gryt_user_id: string }>();
  if (ids.length === 0) return result;
  const db = getSqliteDb();
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db.prepare(`SELECT server_user_id, gryt_user_id, nickname, avatar_file_id, avatar_worn FROM users WHERE server_user_id IN (${placeholders})`).all(...unique) as Record<string, unknown>[];
  for (const r of rows) {
    result.set(r.server_user_id as string, {
      nickname: (r.nickname as string) ?? "Unknown",
      avatar_file_id: (r.avatar_file_id as string) || undefined,
      // So a direct message draws the same avatar as the member list: a field on
      // one builder and not the other unwears an owl in half the UI.
      avatar_worn: (r.avatar_worn as string) ?? null,
      gryt_user_id: (r.gryt_user_id as string) ?? "",
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

/** `no_prior_membership` is ordinary; `account_already_member` is the collision,
    where the guest membership stays put and something is left behind. */
export type CarryIdentityResult =
  | { status: "carried" }
  | { status: "no_prior_membership" }
  | { status: "account_already_member" };

/** Reuses `replaceUserIdentity`, which carries ownership and revokes the old
    refresh tokens. Never merges: a collision is reported, not resolved. */
export async function carryIdentityForward(
  priorGrytUserId: string,
  newGrytUserId: string,
): Promise<CarryIdentityResult> {
  const prior = await getUserByGrytId(priorGrytUserId);
  if (!prior) return { status: "no_prior_membership" };

  const alreadyMember = await getUserByGrytId(newGrytUserId);
  if (alreadyMember) return { status: "account_already_member" };

  await replaceUserIdentity(prior.server_user_id, newGrytUserId);
  return { status: "carried" };
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

/** Both halves together: the bump invalidates tokens already held and the revoke
    stops new ones being minted, and either alone leaves a way in. */
export async function revokeUserSessions(grytUserId: string): Promise<void> {
  const db = getSqliteDb();
  db.prepare("UPDATE users SET token_version = token_version + 1 WHERE gryt_user_id = ?").run(grytUserId);
  await revokeUserRefreshTokens(grytUserId).catch(() => {});
}
