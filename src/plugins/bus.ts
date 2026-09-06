/**
 * How a server plugin hears about things (GRYT-933).
 *
 * Plugins run in this process, so the only thing standing between a bad one and
 * the server going down is what happens around the call. That is what this file
 * is: the events themselves are a handful of plain objects, and everything else
 * here is containment.
 *
 * Three failures it is built around, in the order they bite:
 *
 * 1. **A handler throws.** Uncaught, that propagates into whichever socket
 *    handler emitted the event and fails the operation for the member who
 *    triggered it — somebody's message not sending because a plugin has a typo.
 * 2. **A handler rejects.** An async handler's rejection is invisible to a
 *    plain try/catch around the call, and an unhandled rejection takes the
 *    process down on Node's default. Both are caught.
 * 3. **A handler throws every time.** Catching alone turns that into an
 *    infinite log and a permanent tax on every message. After enough failures
 *    the plugin is dropped and said so, once.
 *
 * What this deliberately does not do is wait. `emit` returns as soon as it has
 * handed the payload out; a plugin that takes ten seconds delays itself and
 * nothing else. That is also why stage one is observe-only — a plugin that
 * could *refuse* a message would have to be awaited, and then a slow plugin is
 * a slow server.
 */

/** Everything a plugin can hear. Adding one means adding it here first. */
export interface PluginEvents {
  "message:created": {
    messageId: string;
    channelId: string;
    /** The member's id on this server, not their identity key. */
    userId: string;
    nickname: string | null;
    text: string;
    attachmentCount: number;
    at: string;
  };
  "member:joined": {
    userId: string;
    nickname: string | null;
    /** Null when they did not come in through an invite. */
    invitecode: string | null;
    at: string;
  };
  "member:left": {
    userId: string;
    nickname: string | null;
    at: string;
  };
}

export type PluginEventName = keyof PluginEvents;

export type PluginEventHandler<E extends PluginEventName> = (
  payload: PluginEvents[E],
) => void | Promise<void>;

/**
 * How many times one plugin may fail before it stops being called.
 *
 * Counted per plugin rather than per handler, because a plugin whose code
 * throws is broken as a whole and the second handler is no more likely to work
 * than the first. Ten is enough that a transient failure — a network call in a
 * handler, a database busy — does not disable anything, and few enough that a
 * plugin broken on every message is gone within a second of traffic.
 */
export const FAILURES_BEFORE_DISABLE = 10;

export interface BusLogger {
  warn(message: string): void;
  error(message: string): void;
}

interface Subscription<E extends PluginEventName> {
  pluginId: string;
  handler: PluginEventHandler<E>;
}

export interface PluginBus {
  subscribe<E extends PluginEventName>(
    pluginId: string,
    event: E,
    handler: PluginEventHandler<E>,
  ): void;
  emit<E extends PluginEventName>(event: E, payload: PluginEvents[E]): void;
  /** Drop everything one plugin subscribed. Used when it is disabled or unloaded. */
  remove(pluginId: string): void;
  /** For the log line at startup and for tests. */
  stats(): { plugins: string[]; disabled: string[]; subscriptions: number };
}

/*
 * Handed to each handler as its own copy.
 *
 * Without this the first plugin to receive an event can rewrite it for every
 * plugin after it, and for the server if the object came from somewhere that
 * still holds it. Two plugins seeing different text for the same message,
 * depending on load order, is the kind of bug that never gets found.
 *
 * structuredClone rather than a spread: the payloads are shallow today and a
 * spread would quietly stop protecting the moment one is not.
 */
function copyFor<T>(payload: T): T {
  try {
    return structuredClone(payload);
  } catch {
    /* Only reachable if a payload picks up something unclonable, which would be
       a bug in the emit site rather than in the plugin. Better to deliver the
       original than to drop the event silently. */
    return payload;
  }
}

export function createPluginBus(logger: BusLogger): PluginBus {
  const subscriptions = new Map<PluginEventName, Subscription<PluginEventName>[]>();
  const failures = new Map<string, number>();
  const disabled = new Set<string>();

  function disable(pluginId: string, why: string): void {
    if (disabled.has(pluginId)) return;
    disabled.add(pluginId);
    remove(pluginId);
    logger.error(
      `plugin ${pluginId} failed ${FAILURES_BEFORE_DISABLE} times and will not be called again: ${why}`,
    );
  }

  function recordFailure(pluginId: string, event: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const count = (failures.get(pluginId) ?? 0) + 1;
    failures.set(pluginId, count);

    if (count >= FAILURES_BEFORE_DISABLE) {
      disable(pluginId, message);
      return;
    }
    logger.warn(`plugin ${pluginId} threw handling ${event}: ${message}`);
  }

  function remove(pluginId: string): void {
    for (const [event, list] of subscriptions) {
      const kept = list.filter((s) => s.pluginId !== pluginId);
      if (kept.length === 0) subscriptions.delete(event);
      else subscriptions.set(event, kept);
    }
  }

  return {
    subscribe(pluginId, event, handler) {
      /* A plugin already disabled must not be able to re-arm itself by
         subscribing again from inside a handler that is still running. */
      if (disabled.has(pluginId)) return;

      const list = subscriptions.get(event) ?? [];
      list.push({ pluginId, handler } as Subscription<PluginEventName>);
      subscriptions.set(event, list);
    },

    emit(event, payload) {
      const list = subscriptions.get(event);
      if (!list || list.length === 0) return;

      /* Copied before iterating, because a handler may subscribe or disable
         during the loop and mutating the array underneath it would skip
         somebody. */
      for (const { pluginId, handler } of [...list]) {
        if (disabled.has(pluginId)) continue;

        try {
          const result = (handler as PluginEventHandler<typeof event>)(copyFor(payload));
          /* A rejection is not something the try/catch above can see. Checking
             for a thenable rather than for a Promise, so a handler returning
             any promise-alike is still caught. */
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => recordFailure(pluginId, event, err));
          }
        } catch (err) {
          recordFailure(pluginId, event, err);
        }
      }
    },

    remove,

    stats() {
      const plugins = new Set<string>();
      let count = 0;
      for (const list of subscriptions.values()) {
        count += list.length;
        for (const s of list) plugins.add(s.pluginId);
      }
      return { plugins: [...plugins].sort(), disabled: [...disabled].sort(), subscriptions: count };
    },
  };
}
