import { getSqliteDb, toIso } from "./connection";

/** A phone that asked to be woken for this account (GRYT-1656). */
export interface PushDevice {
  installId: string;
  capability: string;
  /** Conversations muted on that phone, which never reach the relay (GRYT-1689). */
  muted: ReadonlySet<string>;
}

/** More than this and the oldest goes. Nobody has ten phones; a reinstall loop might. */
export const MAX_PUSH_DEVICES_PER_USER = 10;

/** The phone checks in on every connect. One silent this long is probably in a drawer. */
export const PUSH_DEVICE_STALE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseMuted(raw: string): ReadonlySet<string> {
  try {
    const value = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function savePushDevice(
  serverUserId: string,
  installId: string,
  capability: string,
  muted: readonly string[] = [],
  now = new Date(),
): void {
  const db = getSqliteDb();
  const at = toIso(now);
  db.prepare(
    `INSERT INTO push_devices (server_user_id, install_id, capability, muted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_user_id, install_id) DO UPDATE SET capability = excluded.capability, muted = excluded.muted, updated_at = excluded.updated_at`,
  ).run(serverUserId, installId, capability, JSON.stringify(muted), at, at);
  db.prepare(
    `DELETE FROM push_devices WHERE server_user_id = ? AND install_id NOT IN (
       SELECT install_id FROM push_devices WHERE server_user_id = ? ORDER BY updated_at DESC, install_id LIMIT ?)`,
  ).run(serverUserId, serverUserId, MAX_PUSH_DEVICES_PER_USER);
}

/** Only phones that checked in lately. The rest are dropped here, one account at a time. */
export function listPushDevices(serverUserId: string, now = new Date()): PushDevice[] {
  const db = getSqliteDb();
  const cutoff = toIso(new Date(now.getTime() - PUSH_DEVICE_STALE_DAYS * DAY_MS));
  db.prepare(`DELETE FROM push_devices WHERE server_user_id = ? AND updated_at < ?`).run(serverUserId, cutoff);
  const rows = db
    .prepare(`SELECT install_id, capability, muted FROM push_devices WHERE server_user_id = ?`)
    .all(serverUserId) as { install_id: string; capability: string; muted: string }[];
  return rows.map((r) => ({ installId: r.install_id, capability: r.capability, muted: parseMuted(r.muted) }));
}

export function removePushDevice(serverUserId: string, installId: string): void {
  getSqliteDb().prepare(`DELETE FROM push_devices WHERE server_user_id = ? AND install_id = ?`).run(serverUserId, installId);
}

/** The relay said the phone is gone, so every account on it here stops trying. */
export function removePushCapability(capability: string): void {
  getSqliteDb().prepare(`DELETE FROM push_devices WHERE capability = ?`).run(capability);
}
