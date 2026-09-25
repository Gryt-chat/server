import { randomUUID } from "crypto";
import type { DatabaseSync } from "node:sqlite";

import { getSqliteDb, toIso } from "./connection";

/**
 * The MLS delivery service's storage (GRYT-1500). Every blob is opaque here; the
 * columns beside it are what ordering, routing and retention read.
 */

/** Five devices per person per server, from docs/mls-design.md in the crypto repo. */
export const MLS_MAX_DEVICES = 5;

/** Unclaimed KeyPackages a device may hold, not counting its last-resort one. */
export const MLS_MAX_KEY_PACKAGES = 20;

export type MlsLogKind = "commit" | "proposal" | "application";

export interface MlsDevice {
  serverUserId: string;
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface MlsGroup {
  groupId: string;
  conversationId: string;
  epoch: number;
  headSeq: number;
  createdByServerUserId: string;
  createdAt: string;
}

export interface MlsLogEntry {
  groupId: string;
  seq: number;
  kind: MlsLogKind;
  epoch: number;
  senderServerUserId: string;
  senderDeviceId: string;
  data: Uint8Array;
  createdAt: string;
}

export interface MlsWelcome {
  welcomeId: string;
  groupId: string;
  conversationId: string | null;
  deviceId: string;
  data: Uint8Array;
  createdAt: string;
}

/* node:sqlite is synchronous, so a read and its write can't interleave in-process;
   IMMEDIATE also shuts out the image worker's process between them. */
function inTransaction<T>(fn: () => T): T {
  const db = getSqliteDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function rowToGroup(r: Record<string, unknown>): MlsGroup {
  return {
    groupId: r.group_id as string,
    conversationId: r.conversation_id as string,
    epoch: Number(r.epoch),
    headSeq: Number(r.head_seq),
    createdByServerUserId: r.created_by_server_user_id as string,
    createdAt: r.created_at as string,
  };
}

function rowToEntry(r: Record<string, unknown>): MlsLogEntry {
  return {
    groupId: r.group_id as string,
    seq: Number(r.seq),
    kind: r.kind as MlsLogKind,
    epoch: Number(r.epoch),
    senderServerUserId: r.sender_server_user_id as string,
    senderDeviceId: r.sender_device_id as string,
    data: r.data as Uint8Array,
    createdAt: r.created_at as string,
  };
}

// ── Devices ─────────────────────────────────────────────────────────────

/** A new device past the cap is refused; a known one only has last_seen_at moved. */
export function touchMlsDevice(
  serverUserId: string,
  deviceId: string,
  now = new Date(),
): "ok" | "too_many_devices" {
  return inTransaction(() => {
    const db = getSqliteDb();
    const at = toIso(now);
    const known = db
      .prepare(`UPDATE mls_devices SET last_seen_at = ? WHERE server_user_id = ? AND device_id = ?`)
      .run(at, serverUserId, deviceId);
    if (Number(known.changes) > 0) return "ok";

    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM mls_devices WHERE server_user_id = ?`)
      .get(serverUserId) as { n: number };
    if (n >= MLS_MAX_DEVICES) return "too_many_devices";

    db.prepare(
      `INSERT INTO mls_devices (server_user_id, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
    ).run(serverUserId, deviceId, at, at);
    return "ok";
  });
}

export function isMlsDevice(serverUserId: string, deviceId: string): boolean {
  return !!getSqliteDb()
    .prepare(`SELECT 1 FROM mls_devices WHERE server_user_id = ? AND device_id = ?`)
    .get(serverUserId, deviceId);
}

export function listMlsDevices(serverUserIds: string[]): MlsDevice[] {
  if (serverUserIds.length === 0) return [];
  const marks = serverUserIds.map(() => "?").join(", ");
  const rows = getSqliteDb()
    .prepare(
      `SELECT server_user_id, device_id, created_at, last_seen_at FROM mls_devices
        WHERE server_user_id IN (${marks}) ORDER BY server_user_id, created_at`,
    )
    .all(...serverUserIds) as Record<string, string>[];
  return rows.map((r) => ({
    serverUserId: r.server_user_id,
    deviceId: r.device_id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
}

/** Its KeyPackages and waiting Welcomes go with it, since nothing can use them now. */
export function removeMlsDevice(serverUserId: string, deviceId: string): boolean {
  return inTransaction(() => {
    const db = getSqliteDb();
    const gone = db
      .prepare(`DELETE FROM mls_devices WHERE server_user_id = ? AND device_id = ?`)
      .run(serverUserId, deviceId);
    db.prepare(`DELETE FROM mls_key_packages WHERE server_user_id = ? AND device_id = ?`).run(serverUserId, deviceId);
    db.prepare(`DELETE FROM mls_welcomes WHERE server_user_id = ? AND device_id = ?`).run(serverUserId, deviceId);
    return Number(gone.changes) > 0;
  });
}

/** A guest folded into an account brings its devices along. Where both hold one
    device id, the account's row is kept. Runs inside the merge's transaction. */
export function carryMlsDevicesForward(db: DatabaseSync, from: string, to: string): void {
  db.prepare(
    `DELETE FROM mls_devices WHERE server_user_id = ?
        AND device_id IN (SELECT device_id FROM mls_devices WHERE server_user_id = ?)`,
  ).run(from, to);
  db.prepare(`UPDATE mls_devices SET server_user_id = ? WHERE server_user_id = ?`).run(to, from);
  db.prepare(`UPDATE mls_key_packages SET server_user_id = ? WHERE server_user_id = ?`).run(to, from);
  db.prepare(`UPDATE mls_welcomes SET server_user_id = ? WHERE server_user_id = ?`).run(to, from);
}

// ── KeyPackages ─────────────────────────────────────────────────────────

export interface NewKeyPackage {
  /** Hex KeyPackageRef, which is how a Welcome names its recipient. */
  ref: string;
  data: Uint8Array;
  lastResort: boolean;
}

/**
 * Stores up to the cap and says how many it took. A new last-resort package retires
 * the old one, whose row stays so a Welcome naming it can still be routed.
 */
export function addMlsKeyPackages(
  serverUserId: string,
  deviceId: string,
  packages: NewKeyPackage[],
  now = new Date(),
): { stored: number; unclaimed: number; lastResort: boolean } {
  return inTransaction(() => {
    const db = getSqliteDb();
    const at = toIso(now);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO mls_key_packages
         (key_package_ref, server_user_id, device_id, data, last_resort, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const retire = db.prepare(
      `UPDATE mls_key_packages SET data = NULL, claimed_at = ?
        WHERE server_user_id = ? AND device_id = ? AND last_resort = 1
          AND claimed_at IS NULL AND key_package_ref != ?`,
    );
    let unclaimed = countMlsKeyPackages(serverUserId, deviceId).unclaimed;

    let stored = 0;
    for (const p of packages) {
      if (!p.lastResort && unclaimed >= MLS_MAX_KEY_PACKAGES) continue;
      const r = insert.run(p.ref, serverUserId, deviceId, p.data, p.lastResort ? 1 : 0, at);
      if (Number(r.changes) === 0) continue;
      if (p.lastResort) retire.run(at, serverUserId, deviceId, p.ref);
      stored += 1;
      if (!p.lastResort) unclaimed += 1;
    }
    return { stored, ...countMlsKeyPackages(serverUserId, deviceId) };
  });
}

export function countMlsKeyPackages(serverUserId: string, deviceId: string): { unclaimed: number; lastResort: boolean } {
  const db = getSqliteDb();
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mls_key_packages
        WHERE server_user_id = ? AND device_id = ? AND last_resort = 0 AND claimed_at IS NULL`,
    )
    .get(serverUserId, deviceId) as { n: number };
  const last = db
    .prepare(
      `SELECT 1 FROM mls_key_packages
        WHERE server_user_id = ? AND device_id = ? AND last_resort = 1 AND claimed_at IS NULL`,
    )
    .get(serverUserId, deviceId);
  return { unclaimed: n, lastResort: !!last };
}

/**
 * Hands out one package, oldest first, and forgets its bytes. The last-resort one is
 * handed out again and again once the rest are gone, which RFC 9420 allows.
 */
export function claimMlsKeyPackage(
  serverUserId: string,
  deviceId: string,
  now = new Date(),
): { ref: string; data: Uint8Array; lastResort: boolean } | null {
  return inTransaction(() => {
    const db = getSqliteDb();
    const fresh = db
      .prepare(
        `SELECT key_package_ref, data FROM mls_key_packages
          WHERE server_user_id = ? AND device_id = ? AND last_resort = 0 AND claimed_at IS NULL
          ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(serverUserId, deviceId) as { key_package_ref: string; data: Uint8Array } | undefined;
    if (fresh) {
      db.prepare(`UPDATE mls_key_packages SET data = NULL, claimed_at = ? WHERE key_package_ref = ?`).run(
        toIso(now),
        fresh.key_package_ref,
      );
      return { ref: fresh.key_package_ref, data: fresh.data, lastResort: false };
    }

    const last = db
      .prepare(
        `SELECT key_package_ref, data FROM mls_key_packages
          WHERE server_user_id = ? AND device_id = ? AND last_resort = 1 AND claimed_at IS NULL`,
      )
      .get(serverUserId, deviceId) as { key_package_ref: string; data: Uint8Array } | undefined;
    return last ? { ref: last.key_package_ref, data: last.data, lastResort: true } : null;
  });
}

/** Whose package a ref was, claimed or not, for as long as the row is kept. */
export function mlsKeyPackageOwner(ref: string): { serverUserId: string; deviceId: string } | null {
  const row = getSqliteDb()
    .prepare(`SELECT server_user_id, device_id FROM mls_key_packages WHERE key_package_ref = ?`)
    .get(ref) as { server_user_id: string; device_id: string } | undefined;
  return row ? { serverUserId: row.server_user_id, deviceId: row.device_id } : null;
}

// ── Groups ──────────────────────────────────────────────────────────────

export function getMlsGroup(groupId: string): MlsGroup | null {
  const row = getSqliteDb().prepare(`SELECT * FROM mls_groups WHERE group_id = ?`).get(groupId);
  return row ? rowToGroup(row as Record<string, unknown>) : null;
}

export function getMlsGroupForConversation(conversationId: string): MlsGroup | null {
  const row = getSqliteDb().prepare(`SELECT * FROM mls_groups WHERE conversation_id = ?`).get(conversationId);
  return row ? rowToGroup(row as Record<string, unknown>) : null;
}

/** The first group registered for a conversation wins, and the loser is handed the winner. */
export function createMlsGroup(
  groupId: string,
  conversationId: string,
  createdByServerUserId: string,
  now = new Date(),
): { created: true; group: MlsGroup } | { created: false; group: MlsGroup | null } {
  return inTransaction(() => {
    const existing = getMlsGroupForConversation(conversationId);
    if (existing) return { created: false as const, group: existing };
    // A group id already used for another conversation: refused, saying nothing about it.
    if (getMlsGroup(groupId)) return { created: false as const, group: null };

    getSqliteDb()
      .prepare(
        `INSERT INTO mls_groups (group_id, conversation_id, epoch, head_seq, created_by_server_user_id, created_at)
         VALUES (?, ?, 0, 0, ?, ?)`,
      )
      .run(groupId, conversationId, createdByServerUserId, toIso(now));
    return { created: true as const, group: getMlsGroup(groupId)! };
  });
}

export function listMlsGroupsForMember(serverUserId: string): (MlsGroup & { oldestSeq: number | null })[] {
  const rows = getSqliteDb()
    .prepare(
      `SELECT g.*, (SELECT MIN(seq) FROM mls_log l WHERE l.group_id = g.group_id) AS oldest_seq
         FROM mls_groups g
         JOIN conversation_members m ON m.conversation_id = g.conversation_id
        WHERE m.server_user_id = ?`,
    )
    .all(serverUserId) as Record<string, unknown>[];
  return rows.map((r) => ({ ...rowToGroup(r), oldestSeq: r.oldest_seq == null ? null : Number(r.oldest_seq) }));
}

/** With the conversation it belongs to. A DM id comes from the pair, so a group left
    behind would be handed to the next conversation those two open. */
export function dropMlsGroupForConversation(conversationId: string): void {
  const group = getMlsGroupForConversation(conversationId);
  if (!group) return;
  const db = getSqliteDb();
  db.prepare(`DELETE FROM mls_log WHERE group_id = ?`).run(group.groupId);
  db.prepare(`DELETE FROM mls_welcomes WHERE group_id = ?`).run(group.groupId);
  db.prepare(`DELETE FROM mls_groups WHERE group_id = ?`).run(group.groupId);
}

// ── The log ─────────────────────────────────────────────────────────────

export interface MlsAppend {
  groupId: string;
  epoch: number;
  senderServerUserId: string;
  senderDeviceId: string;
  data: Uint8Array;
}

export interface MlsWelcomeFor {
  serverUserId: string;
  deviceId: string;
  data: Uint8Array;
}

/** How far back a resend is recognised. A retry comes seconds after the first try. */
const DUPLICATE_WINDOW = 100;

/* The same bytes again, from a client that never heard back. Written once, so a
   receiver doesn't fail on a generation it has already used. */
function recentDuplicate(group: MlsGroup, data: Uint8Array): { seq: number; epoch: number; created_at: string } | undefined {
  return getSqliteDb()
    .prepare(`SELECT seq, epoch, created_at FROM mls_log WHERE group_id = ? AND seq > ? AND data = ? LIMIT 1`)
    .get(group.groupId, group.headSeq - DUPLICATE_WINDOW, data) as
    | { seq: number; epoch: number; created_at: string }
    | undefined;
}

export type MlsCommitResult =
  | { accepted: true; seq: number; epoch: number; createdAt: string; welcomeIds: string[]; duplicate: boolean }
  | { accepted: false; reason: "no_group" }
  | { accepted: false; reason: "stale_epoch"; epoch: number; headSeq: number };

function insertEntry(kind: MlsLogKind, a: MlsAppend, seq: number, at: string): void {
  getSqliteDb()
    .prepare(
      `INSERT INTO mls_log (group_id, seq, kind, epoch, sender_server_user_id, sender_device_id, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(a.groupId, seq, kind, a.epoch, a.senderServerUserId, a.senderDeviceId, a.data, at);
}

/**
 * One commit per epoch: the first one built on the current epoch is written and moves
 * the group on. Any other is refused with the epoch it should have used.
 */
export function appendMlsCommit(a: MlsAppend, welcomes: MlsWelcomeFor[] = [], now = new Date()): MlsCommitResult {
  return inTransaction(() => {
    const db = getSqliteDb();
    const group = getMlsGroup(a.groupId);
    if (!group) return { accepted: false as const, reason: "no_group" as const };
    const dup = recentDuplicate(group, a.data);
    if (dup) {
      const epoch = Number(dup.epoch) + 1;
      return { accepted: true as const, seq: Number(dup.seq), epoch, createdAt: dup.created_at, welcomeIds: [], duplicate: true };
    }
    if (a.epoch !== group.epoch) {
      return { accepted: false as const, reason: "stale_epoch" as const, epoch: group.epoch, headSeq: group.headSeq };
    }

    const at = toIso(now);
    const seq = group.headSeq + 1;
    insertEntry("commit", a, seq, at);
    db.prepare(`UPDATE mls_groups SET epoch = ?, head_seq = ? WHERE group_id = ?`).run(group.epoch + 1, seq, a.groupId);

    const insertWelcome = db.prepare(
      `INSERT INTO mls_welcomes (welcome_id, server_user_id, device_id, group_id, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const welcomeIds = welcomes.map((w) => {
      const id = randomUUID();
      insertWelcome.run(id, w.serverUserId, w.deviceId, a.groupId, w.data, at);
      return id;
    });
    return { accepted: true as const, seq, epoch: group.epoch + 1, createdAt: at, welcomeIds, duplicate: false };
  });
}

export type MlsMessageResult =
  | { accepted: true; seq: number; createdAt: string; duplicate: boolean }
  | { accepted: false; reason: "no_group" }
  | { accepted: false; reason: "future_epoch"; epoch: number };

/** Not ordered by epoch, but none can come from an epoch that hasn't happened yet. */
export function appendMlsMessage(
  kind: Exclude<MlsLogKind, "commit">,
  a: MlsAppend,
  now = new Date(),
): MlsMessageResult {
  return inTransaction(() => {
    const group = getMlsGroup(a.groupId);
    if (!group) return { accepted: false as const, reason: "no_group" as const };
    if (a.epoch > group.epoch) return { accepted: false as const, reason: "future_epoch" as const, epoch: group.epoch };
    const dup = recentDuplicate(group, a.data);
    if (dup) return { accepted: true as const, seq: Number(dup.seq), createdAt: dup.created_at, duplicate: true };

    const at = toIso(now);
    const seq = group.headSeq + 1;
    insertEntry(kind, a, seq, at);
    getSqliteDb().prepare(`UPDATE mls_groups SET head_seq = ? WHERE group_id = ?`).run(seq, a.groupId);
    return { accepted: true as const, seq, createdAt: at, duplicate: false };
  });
}

/** Oldest first, after the cursor. */
export function listMlsLog(groupId: string, afterSeq: number, limit: number): MlsLogEntry[] {
  const rows = getSqliteDb()
    .prepare(`SELECT * FROM mls_log WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
    .all(groupId, afterSeq, limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function oldestMlsSeq(groupId: string): number | null {
  const row = getSqliteDb().prepare(`SELECT MIN(seq) AS s FROM mls_log WHERE group_id = ?`).get(groupId) as {
    s: number | null;
  };
  return row.s == null ? null : Number(row.s);
}

// ── Welcomes ────────────────────────────────────────────────────────────

export function listMlsWelcomes(serverUserId: string, deviceId: string): MlsWelcome[] {
  const rows = getSqliteDb()
    .prepare(
      `SELECT w.welcome_id, w.group_id, w.device_id, w.data, w.created_at, g.conversation_id
         FROM mls_welcomes w LEFT JOIN mls_groups g ON g.group_id = w.group_id
        WHERE w.server_user_id = ? AND w.device_id = ?
        ORDER BY w.created_at, w.rowid`,
    )
    .all(serverUserId, deviceId) as Record<string, unknown>[];
  return rows.map((r) => ({
    welcomeId: r.welcome_id as string,
    groupId: r.group_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    deviceId: r.device_id as string,
    data: r.data as Uint8Array,
    createdAt: r.created_at as string,
  }));
}

/** Only this device's own: an id belonging to anybody else deletes nothing. */
export function deleteMlsWelcomes(serverUserId: string, deviceId: string, welcomeIds: string[]): number {
  const del = getSqliteDb().prepare(
    `DELETE FROM mls_welcomes WHERE welcome_id = ? AND server_user_id = ? AND device_id = ?`,
  );
  let n = 0;
  for (const id of welcomeIds) n += Number(del.run(id, serverUserId, deviceId).changes);
  return n;
}

// ── Retention ───────────────────────────────────────────────────────────

/**
 * Drops ciphertext, Welcomes and claimed package refs older than the cutoff, and every
 * group whose conversation is gone. A kept group's epoch and head_seq never go back.
 */
export function sweepMls(cutoff: Date): { log: number; welcomes: number; keyPackages: number; groups: number } {
  return inTransaction(() => {
    const db = getSqliteDb();
    const before = toIso(cutoff);
    const orphans = db
      .prepare(
        `SELECT conversation_id FROM mls_groups g
          WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.conversation_id = g.conversation_id)`,
      )
      .all() as { conversation_id: string }[];
    for (const { conversation_id } of orphans) dropMlsGroupForConversation(conversation_id);

    const log = db.prepare(`DELETE FROM mls_log WHERE created_at < ?`).run(before);
    const welcomes = db.prepare(`DELETE FROM mls_welcomes WHERE created_at < ?`).run(before);
    const keyPackages = db
      .prepare(`DELETE FROM mls_key_packages WHERE claimed_at IS NOT NULL AND claimed_at < ?`)
      .run(before);
    return {
      log: Number(log.changes),
      welcomes: Number(welcomes.changes),
      keyPackages: Number(keyPackages.changes),
      groups: orphans.length,
    };
  });
}
