import consola from "consola";

import { expireMlsDevices, listConversationsForUser, sweepMls } from "../db";
import { emitToMember } from "../socket/utils/server";
import { deleteUnreferencedFiles } from "./mediaSweep";

/** Decision 7 in docs/mls-design.md: 30 days, and a host can make it shorter but not longer. */
export const MLS_MAX_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

/** `MLS_RETENTION_DAYS`, whole days from 1 to 30. Anything else is read as 30. */
export function mlsRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MLS_RETENTION_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return MLS_MAX_RETENTION_DAYS;
  const days = Number(raw);
  return days >= 1 && days <= MLS_MAX_RETENTION_DAYS ? days : MLS_MAX_RETENTION_DAYS;
}

export function runMlsRetention(now = new Date()): ReturnType<typeof sweepMls> {
  const cutoff = new Date(now.getTime() - mlsRetentionDays() * DAY_MS);
  const swept = sweepMls(cutoff, now);
  // Past the cutoff its log is gone, so it couldn't follow its DMs anyway. Members take it out.
  const quiet = expireMlsDevices(cutoff);
  if (quiet.length > 0) {
    consola.info("[mls-retention] expired quiet devices", { devices: quiet.length });
    for (const serverUserId of new Set(quiet.map((d) => d.serverUserId))) {
      void announceDevices(serverUserId).catch((err) => consola.warn("[mls-retention] announcing expired devices failed", err));
    }
  }
  const { fileIds, ...counts } = swept;
  if (swept.log || swept.welcomes || swept.keyPackages || swept.expired || swept.groups) {
    consola.info("[mls-retention] swept", { ...counts, files: fileIds.length });
  }
  // As a deleted message's files go: now if nothing else holds them, else the media sweep's.
  if (fileIds.length > 0) {
    void deleteUnreferencedFiles(fileIds).catch((err) => consola.warn("[mls-retention] file cleanup failed", err));
  }
  return swept;
}

async function announceDevices(serverUserId: string): Promise<void> {
  const people = new Set([serverUserId]);
  for (const c of await listConversationsForUser(serverUserId)) for (const id of c.other_server_user_ids) people.add(id);
  for (const id of people) emitToMember(id, "mls:devices:changed", { serverUserId });
}

export function startMlsRetention(): void {
  if (timer) return;
  const sweep = () => {
    try {
      runMlsRetention();
    } catch (err) {
      consola.error("[mls-retention] sweep failed", err);
    }
  };
  sweep();
  timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
}
