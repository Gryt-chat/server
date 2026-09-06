/**
 * What a plugin is handed when it starts (GRYT-933).
 *
 * The whole surface, deliberately: an id, a logger, and `on`. A plugin can
 * reach far more than this — it has the Node runtime — and the point of keeping
 * the API small is not that it stops anything. It is that the honest path is
 * obvious and narrow, so a plugin doing something outside it is visible in its
 * own source rather than buried in what looks like ordinary use.
 */

import type { PluginBus, PluginEventHandler, PluginEventName } from "./bus";
import type { PluginCapability, PluginManifest } from "./manifest";

/**
 * Which capability an event is behind.
 *
 * A total map rather than a lookup with a default, so adding an event to
 * `PluginEvents` and forgetting to say what it costs is a type error here
 * rather than an event that quietly needs nothing.
 */
export const EVENT_CAPABILITY: Record<PluginEventName, PluginCapability> = {
  "message:created": "messages:read",
  "member:joined": "members:read",
  "member:left": "members:read",
};

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GrytServerApi {
  /** This plugin's own id, so it does not have to hard-code the folder name. */
  readonly id: string;
  /** What the manifest declared, normalised. Readable so a plugin can degrade. */
  readonly capabilities: readonly PluginCapability[];
  /**
   * Subscribe to an event. Throws if the manifest did not ask for the
   * capability behind it.
   *
   * Throwing rather than returning false, and throwing at subscribe rather than
   * failing silently at delivery: a plugin that never receives an event it
   * thought it had asked for is a bad afternoon, and the stack trace at startup
   * names the line.
   */
  on<E extends PluginEventName>(event: E, handler: PluginEventHandler<E>): void;
  /** Goes to the server log, prefixed with the plugin id. */
  readonly log: PluginLogger;
}

export class CapabilityError extends Error {
  constructor(pluginId: string, event: string, capability: string) {
    super(
      `plugin ${pluginId} subscribed to ${event} without declaring ${capability} in its manifest`,
    );
    this.name = "CapabilityError";
  }
}

export function createPluginApi(
  manifest: PluginManifest,
  bus: PluginBus,
  logger: PluginLogger,
): GrytServerApi {
  const capabilities = Object.freeze([...manifest.capabilities]);

  const prefixed: PluginLogger = {
    info: (m) => logger.info(`[${manifest.id}] ${m}`),
    warn: (m) => logger.warn(`[${manifest.id}] ${m}`),
    error: (m) => logger.error(`[${manifest.id}] ${m}`),
  };

  return {
    id: manifest.id,
    capabilities,

    on(event, handler) {
      const needed = EVENT_CAPABILITY[event];
      /*
       * An event this build does not know about has no entry, and defaulting to
       * "allowed" would make a typo in an event name into a free subscription.
       * It never fires either way, so refusing is the answer that says why.
       */
      if (!needed) {
        throw new CapabilityError(manifest.id, event, "an event this server does not have");
      }
      if (!capabilities.includes(needed)) {
        throw new CapabilityError(manifest.id, event, needed);
      }
      bus.subscribe(manifest.id, event, handler);
    },

    log: prefixed,
  };
}
