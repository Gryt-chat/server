import consola from "consola";

import { sweepMls } from "../db";

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
  const swept = sweepMls(new Date(now.getTime() - mlsRetentionDays() * DAY_MS));
  if (swept.log || swept.welcomes || swept.keyPackages || swept.groups) {
    consola.info("[mls-retention] swept", swept);
  }
  return swept;
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
