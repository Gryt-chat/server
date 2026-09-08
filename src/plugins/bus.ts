/**
 * Observe-only, and `emit` never waits: a plugin that could refuse a message
 * would have to be awaited, and then a slow plugin is a slow server. The
 * containment is in `guard.ts`.
 */

import {
  copyForHandler,
  createPluginGuard,
  type GuardLogger,
  type PluginGuard,
} from "./guard";

export { FAILURES_BEFORE_DISABLE } from "./guard";

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
    inviteCode: string | null;
    at: string;
  };
  "member:left": {
    userId: string;
    nickname: string | null;
    /** A plugin logging departures wants a different line for each, and one
        deciding whether to act wants to know a human already did. */
    reason: "left" | "kicked" | "banned";
    at: string;
  };
}

export type PluginEventName = keyof PluginEvents;

export type PluginEventHandler<E extends PluginEventName> = (
  payload: PluginEvents[E],
) => void | Promise<void>;

export type BusLogger = GuardLogger;

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

export function createPluginBus(
  logger: BusLogger,
  /* Defaulted so a test can make a bus on its own. The server passes one in, so
     the failure count is shared with everything else that calls a plugin. */
  guard: PluginGuard = createPluginGuard(logger),
): PluginBus {
  const subscriptions = new Map<PluginEventName, Subscription<PluginEventName>[]>();

  function remove(pluginId: string): void {
    for (const [event, list] of subscriptions) {
      const kept = list.filter((s) => s.pluginId !== pluginId);
      if (kept.length === 0) subscriptions.delete(event);
      else subscriptions.set(event, kept);
    }
  }

  guard.onDisable(remove);

  return {
    subscribe(pluginId, event, handler) {
      /* A plugin already disabled must not be able to re-arm itself by
         subscribing again from inside a handler that is still running. */
      if (guard.isDisabled(pluginId)) return;

      const list = subscriptions.get(event) ?? [];
      list.push({ pluginId, handler } as Subscription<PluginEventName>);
      subscriptions.set(event, list);
    },

    emit(event, payload) {
      const list = subscriptions.get(event);
      if (!list || list.length === 0) return;

      /* Copied before iterating: a handler may subscribe or be disabled during
         the loop, and mutating underneath it skips somebody. */
      for (const { pluginId, handler } of [...list]) {
        guard.call(pluginId, event, () =>
          (handler as PluginEventHandler<typeof event>)(copyForHandler(payload)),
        );
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
      return { plugins: [...plugins].sort(), disabled: guard.disabledIds(), subscriptions: count };
    },
  };
}
