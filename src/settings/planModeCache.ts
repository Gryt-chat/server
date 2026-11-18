import { getServerConfig } from "../db";

import { normalizePlanMode, type PlanMode } from "./planMode";

let cached: { mode: PlanMode; at: number } | null = null;
const CACHE_MS = 5000;

/** Read on every write event, so cached briefly. A mode set through management clears it. */
export async function currentPlanMode(): Promise<PlanMode> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.mode;
  const mode = normalizePlanMode((await getServerConfig())?.plan_mode);
  cached = { mode, at: Date.now() };
  return mode;
}

export function forgetPlanMode(): void {
  cached = null;
}
