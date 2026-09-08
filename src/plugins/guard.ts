/**
 * Catches a throw, catches a rejection, and drops a plugin that keeps failing.
 * Counted per plugin, not per channel, and it never waits.
 */

/** Enough that a busy database disables nothing, few enough that a plugin
    broken on every message is gone within a second of traffic. */
export const FAILURES_BEFORE_DISABLE = 10;

export interface GuardLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginGuard {
  /** Never throws, never waits, never lets a rejection escape. `what` is an
      event name or a message topic, for the log line. */
  call(pluginId: string, what: string, run: () => void | Promise<void>): void;
  isDisabled(pluginId: string): boolean;
  /** Dropped rather than skipped: skipping looks the same from outside while
      the maps fill with dead handlers from a plugin re-subscribing on a timer. */
  onDisable(drop: (pluginId: string) => void): void;
  disabledIds(): string[];
}

/** Or the first plugin rewrites the payload for every one after it. Cloned, not
    spread: a spread stops protecting the moment a payload is not shallow. */
export function copyForHandler<T>(payload: T): T {
  try {
    return structuredClone(payload);
  } catch {
    /* Only reachable if a payload picks up something unclonable, which is a bug
       at the call site. Better delivered than dropped silently. */
    return payload;
  }
}

export function createPluginGuard(logger: GuardLogger): PluginGuard {
  const failures = new Map<string, number>();
  const disabled = new Set<string>();
  const droppers: ((pluginId: string) => void)[] = [];

  function disable(pluginId: string, why: string): void {
    if (disabled.has(pluginId)) return;
    disabled.add(pluginId);
    for (const drop of droppers) drop(pluginId);
    logger.error(
      `plugin ${pluginId} failed ${FAILURES_BEFORE_DISABLE} times and will not be called again: ${why}`,
    );
  }

  function recordFailure(pluginId: string, what: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const count = (failures.get(pluginId) ?? 0) + 1;
    failures.set(pluginId, count);

    if (count >= FAILURES_BEFORE_DISABLE) {
      disable(pluginId, message);
      return;
    }
    logger.warn(`plugin ${pluginId} threw handling ${what}: ${message}`);
  }

  return {
    call(pluginId, what, run) {
      if (disabled.has(pluginId)) return;

      try {
        const result = run();
        /* The try/catch above cannot see a rejection. A thenable rather than a
           Promise, so any promise-alike is still caught. */
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => recordFailure(pluginId, what, err));
        }
      } catch (err) {
        recordFailure(pluginId, what, err);
      }
    },

    isDisabled: (pluginId) => disabled.has(pluginId),
    onDisable: (drop) => void droppers.push(drop),
    disabledIds: () => [...disabled].sort(),
  };
}
