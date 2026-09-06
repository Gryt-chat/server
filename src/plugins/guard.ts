/**
 * What happens around every call into a plugin (GRYT-939).
 *
 * Lifted out of `bus.ts`, where it grew alongside the event bus. It moved when
 * plugins gained a second way to be called — a message from a client plugin —
 * because the interesting number is per plugin and not per channel. A plugin
 * throwing five times on events and five times on messages is a plugin that
 * has thrown ten times, and two separate counters would have let it run
 * forever.
 *
 * The three failures this exists for, unchanged from where it came from:
 *
 * 1. **A handler throws.** Uncaught, it propagates into whichever server code
 *    called the plugin and fails that operation for the member who triggered
 *    it — somebody's message not sending because a plugin has a typo.
 * 2. **A handler rejects.** A plain try/catch around the call cannot see an
 *    async rejection, and an unhandled one takes the process down on Node's
 *    default.
 * 3. **A handler throws every time.** Catching alone turns that into an
 *    infinite log and a permanent tax on every message. After enough failures
 *    the plugin is dropped and said so, once.
 *
 * It never waits. A plugin that takes ten seconds delays itself and nothing
 * else.
 */

/**
 * How many times one plugin may fail before it stops being called.
 *
 * Counted per plugin rather than per handler or per channel, because a plugin
 * whose code throws is broken as a whole and its second handler is no more
 * likely to work than its first. Ten is enough that a transient failure — a
 * network call in a handler, a database busy — disables nothing, and few enough
 * that a plugin broken on every message is gone within a second of traffic.
 */
export const FAILURES_BEFORE_DISABLE = 10;

export interface GuardLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginGuard {
  /**
   * Run one plugin handler. Never throws, never waits, never lets a rejection
   * escape.
   *
   * `what` names the thing being handled, for the log line — an event name, a
   * message topic. It is the only part of this a reader will see.
   */
  call(pluginId: string, what: string, run: () => void | Promise<void>): void;
  isDisabled(pluginId: string): boolean;
  /**
   * Registered by anything holding subscriptions, so a disabled plugin's
   * handlers are dropped rather than merely skipped.
   *
   * Skipping alone would look identical from the outside while the maps filled
   * up with dead handlers from a plugin that re-subscribes on a timer.
   */
  onDisable(drop: (pluginId: string) => void): void;
  disabledIds(): string[];
}

/**
 * Handed to each handler as its own copy.
 *
 * Without this the first plugin to receive something can rewrite it for every
 * plugin after it, and for the server if the object came from somewhere that
 * still holds it. Two plugins seeing different text for the same message,
 * depending on load order, is the kind of bug that never gets found.
 *
 * structuredClone rather than a spread: the payloads are shallow today and a
 * spread would quietly stop protecting the moment one is not.
 */
export function copyForHandler<T>(payload: T): T {
  try {
    return structuredClone(payload);
  } catch {
    /* Only reachable if a payload picks up something unclonable, which would be
       a bug at the call site rather than in the plugin. Better to deliver the
       original than to drop it silently. */
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
        /* A rejection is not something the try/catch above can see. Checking
           for a thenable rather than for a Promise, so a handler returning any
           promise-alike is still caught. */
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
