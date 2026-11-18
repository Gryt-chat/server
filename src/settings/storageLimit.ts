import type { Response } from "express";

import { storedFileBytes } from "../db";

import { PLAN_MODE_MESSAGES } from "./planMode";
import { currentPlanMode } from "./planModeCache";

/** A Gryt Cloud plan's storage, set by the host. Unset or 0 is no limit, as on a self-hosted server. */
export function planStorageBytes(): number | null {
  const n = Number(process.env.GRYT_PLAN_STORAGE_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function gigabytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

/** Refuses an upload once the server has used its plan's storage, or while the plan is lapsed. One upload can go over by its own size. */
export async function refusedForStorage(res: Response): Promise<boolean> {
  const mode = await currentPlanMode();
  if (mode !== "active") {
    res.status(403).json({ error: mode, message: PLAN_MODE_MESSAGES[mode] });
    return true;
  }
  const limit = planStorageBytes();
  if (limit === null) return false;
  const used = await storedFileBytes();
  if (used < limit) return false;
  res.status(413).json({
    error: "storage_full",
    message: `This server has used all of its ${gigabytes(limit)} of storage. Delete old files, or ask the owner to upgrade.`,
    used,
    limit,
  });
  return true;
}
