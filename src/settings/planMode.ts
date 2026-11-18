/* eslint-disable @typescript-eslint/no-restricted-types -- normalizes a database value or a host's patch */
/** A Gryt Cloud server after a failed payment: read-only, then paused. Only management sets it. */
export type PlanMode = "active" | "read_only" | "paused";

export const PLAN_MODES: readonly PlanMode[] = ["active", "read_only", "paused"];

export function normalizePlanMode(v: unknown): PlanMode {
  return PLAN_MODES.includes(v as PlanMode) ? (v as PlanMode) : "active";
}

/** Events that add something. Deleting stays allowed, so an owner can still free space. */
export const WRITE_EVENTS: ReadonlySet<string> = new Set([
  "chat:send", "chat:edit", "chat:react", "chat:pin", "poll:vote",
  "thread:create", "forum:topic:create", "mls:send", "dm:group:create",
  "server:channels:upsert", "server:sidebar:item:upsert", "server:invites:create",
]);

export const PLAN_MODE_MESSAGES: Record<Exclude<PlanMode, "active">, string> = {
  read_only: "This server is read-only until its plan is renewed. You can still read and talk in voice.",
  paused: "This server is paused until its owner renews its plan.",
};

/** Whether a socket event is refused under a mode. In paused mode the owner keeps everything. */
export function refusesEvent(mode: PlanMode, event: string, isOwner: boolean): boolean {
  if (mode === "active") return false;
  if (mode === "paused") return !isOwner;
  return WRITE_EVENTS.has(event);
}
