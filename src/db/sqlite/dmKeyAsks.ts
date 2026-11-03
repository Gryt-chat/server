import { getSqliteDb } from "./connection";

/** A device with its own key asking to take over the account's DM key here (GRYT-2023). */
export interface DmKeyAsk {
  binding: string;
  deviceName: string;
  createdAt: number;
}

/** More than this and the oldest goes. One account asking from five devices at once is already odd. */
export const MAX_DM_KEY_ASKS = 5;

/** Asking again keeps the first time, so it can't be used to keep an ask fresh forever. */
export async function addDmKeyAsk(serverUserId: string, binding: string, deviceName: string, at: number): Promise<void> {
  const d = getSqliteDb();
  d.prepare(
    `INSERT INTO dm_key_asks (server_user_id, binding, device_name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (server_user_id, binding) DO UPDATE SET device_name = excluded.device_name`,
  ).run(serverUserId, binding, deviceName, at);
  d.prepare(
    `DELETE FROM dm_key_asks WHERE server_user_id = ? AND binding NOT IN
       (SELECT binding FROM dm_key_asks WHERE server_user_id = ? ORDER BY created_at DESC LIMIT ?)`,
  ).run(serverUserId, serverUserId, MAX_DM_KEY_ASKS);
}

/** The asks still open, oldest first. Expired ones are deleted on the way. */
export async function listDmKeyAsks(serverUserId: string, maxAgeMs: number, now = Date.now()): Promise<DmKeyAsk[]> {
  const d = getSqliteDb();
  d.prepare("DELETE FROM dm_key_asks WHERE server_user_id = ? AND created_at <= ?").run(serverUserId, now - maxAgeMs);
  const rows = d
    .prepare("SELECT binding, device_name, created_at FROM dm_key_asks WHERE server_user_id = ? ORDER BY created_at")
    .all(serverUserId) as { binding: string; device_name: string; created_at: number }[];
  return rows.map((r) => ({ binding: r.binding, deviceName: r.device_name, createdAt: Number(r.created_at) }));
}

export async function removeDmKeyAsk(serverUserId: string, binding: string): Promise<void> {
  getSqliteDb().prepare("DELETE FROM dm_key_asks WHERE server_user_id = ? AND binding = ?").run(serverUserId, binding);
}
