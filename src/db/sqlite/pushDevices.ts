import { getSqliteDb, toIso } from "./connection";

/** A phone that asked to be woken for this account (GRYT-1656). */
export interface PushDevice {
  installId: string;
  capability: string;
}

/** More than this and the oldest goes. Nobody has ten phones; a reinstall loop might. */
export const MAX_PUSH_DEVICES_PER_USER = 10;

export function savePushDevice(serverUserId: string, installId: string, capability: string): void {
  const db = getSqliteDb();
  const now = toIso(new Date());
  db.prepare(
    `INSERT INTO push_devices (server_user_id, install_id, capability, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(server_user_id, install_id) DO UPDATE SET capability = excluded.capability, updated_at = excluded.updated_at`,
  ).run(serverUserId, installId, capability, now, now);
  db.prepare(
    `DELETE FROM push_devices WHERE server_user_id = ? AND install_id NOT IN (
       SELECT install_id FROM push_devices WHERE server_user_id = ? ORDER BY updated_at DESC, install_id LIMIT ?)`,
  ).run(serverUserId, serverUserId, MAX_PUSH_DEVICES_PER_USER);
}

export function listPushDevices(serverUserId: string): PushDevice[] {
  const rows = getSqliteDb()
    .prepare(`SELECT install_id, capability FROM push_devices WHERE server_user_id = ?`)
    .all(serverUserId) as { install_id: string; capability: string }[];
  return rows.map((r) => ({ installId: r.install_id, capability: r.capability }));
}

export function removePushDevice(serverUserId: string, installId: string): void {
  getSqliteDb().prepare(`DELETE FROM push_devices WHERE server_user_id = ? AND install_id = ?`).run(serverUserId, installId);
}

/** The relay said the phone is gone, so every account on it here stops trying. */
export function removePushCapability(capability: string): void {
  getSqliteDb().prepare(`DELETE FROM push_devices WHERE capability = ?`).run(capability);
}
