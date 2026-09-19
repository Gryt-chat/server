export const SFU_RECONNECT_GRACE_MS = 10_000;

export function withinSfuReconnectGrace(
  connectedAt: number | undefined,
  now = Date.now(),
): boolean {
  if (connectedAt === undefined) return false;
  return now - connectedAt < SFU_RECONNECT_GRACE_MS;
}
