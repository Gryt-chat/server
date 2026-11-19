/* eslint-disable @typescript-eslint/no-restricted-types -- checks dates the host sent over the management API */
/** When a lapsed Gryt Cloud plan turns read-only, pauses and is deleted (ms). The host sends them; members see the countdown. */
export interface PlanDates {
  readOnlyAt?: number;
  pausedAt?: number;
  deletedAt?: number;
}

// In memory on purpose: the Gryt Cloud agent sends them again on every pass, a restart included.
let dates: PlanDates = {};

const when = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** Null clears them, as when the payment goes through. */
export function setPlanDates(input: unknown): void {
  if (input === null) {
    dates = {};
    return;
  }
  if (typeof input !== "object") return;
  const d = input as Record<string, unknown>;
  dates = { readOnlyAt: when(d.readOnlyAt), pausedAt: when(d.pausedAt), deletedAt: when(d.deletedAt) };
}

export function planDates(): PlanDates {
  return dates;
}
