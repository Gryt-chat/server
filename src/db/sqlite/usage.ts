import { getSqliteDb } from "./connection";

export interface UsageNumbers {
  storageBytes: { total: number; byKind: Record<string, number> };
  members: { total: number; active30d: number };
  /** Oldest first, one entry per UTC day that had any, over the last 30 days. */
  messagesPerDay: Array<{ day: string; count: number }>;
}

/** Counts only, never content: what a host needs to see a server's size and how busy it is. */
export function usageNumbers(now = new Date()): UsageNumbers {
  const db = getSqliteDb();
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // The first segment of the key is what the upload was for: uploads, avatars, banners, emojis.
  const kinds = db.prepare(
    `SELECT CASE WHEN instr(s3_key, '/') > 0 THEN substr(s3_key, 1, instr(s3_key, '/') - 1) ELSE 'other' END AS kind,
            COALESCE(SUM(size), 0) AS bytes
       FROM files GROUP BY kind`,
  ).all() as Array<{ kind: string; bytes: number }>;
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const { kind, bytes } of kinds) {
    byKind[kind] = Number(bytes);
    total += Number(bytes);
  }

  const members = db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END), 0) AS active FROM users WHERE is_active = 1`,
  ).get(since) as { total: number; active: number };

  const days = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM messages WHERE created_at >= ? GROUP BY day ORDER BY day`,
  ).all(since) as Array<{ day: string; count: number }>;

  return {
    storageBytes: { total, byKind },
    members: { total: Number(members.total), active30d: Number(members.active) },
    messagesPerDay: days.map((d) => ({ day: d.day, count: Number(d.count) })),
  };
}
