/**
 * What a plugin is handed when it starts (GRYT-933).
 *
 * The whole surface, deliberately: an id, a logger, and `on`. A plugin can
 * reach far more than this — it has the Node runtime — and the point of keeping
 * the API small is not that it stops anything. It is that the honest path is
 * obvious and narrow, so a plugin doing something outside it is visible in its
 * own source rather than buried in what looks like ordinary use.
 */

import { createModerationActions, type PluginModeration } from "./actions";
import { createMessaging, type PluginMessageBus, type PluginMessaging } from "./messaging";
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
  /**
   * Kick and ban. Throws on access if the manifest did not declare
   * `moderation`, rather than handing back an object whose every call refuses
   * — a plugin should find out it has not been given this when it reaches for
   * it, not on the first member it tries to act on.
   *
   * The calls themselves return an outcome rather than throwing. A refusal
   * there is an ordinary answer — the member is a moderator, or already gone —
   * and a plugin should be able to log it and carry on.
   */
  readonly moderation: PluginModeration;
  /**
   * The pipe to the client half of this plugin. Throws on access if the
   * manifest did not declare `messaging`.
   *
   * **What arrives on it was written by a member's client.** Check it. The
   * transport caps the size and the rate and nothing else — the shape is the
   * plugin's to establish, and assuming its own client half is on the other end
   * is the mistake this note exists for.
   */
  readonly messaging: PluginMessaging;
  /** Goes to the server log, prefixed with the plugin id. */
  readonly log: PluginLogger;
}

export class CapabilityError extends Error {
  constructor(pluginId: string, what: string, capability: string) {
    super(
      what === capability
        ? `plugin ${pluginId} reached for ${what} without declaring ${capability} in its manifest`
        : `plugin ${pluginId} subscribed to ${what} without declaring ${capability} in its manifest`,
    );
    this.name = "CapabilityError";
  }
}

export function createPluginApi(
  manifest: PluginManifest,
  bus: PluginBus,
  logger: PluginLogger,
  messageBus?: PluginMessageBus,
): GrytServerApi {
  const capabilities = Object.freeze([...manifest.capabilities]);

  const moderation = createModerationActions(manifest.id);

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

    get messaging(): PluginMessaging {
      if (!capabilities.includes("messaging")) {
        throw new CapabilityError(manifest.id, "messaging", "messaging");
      }
      if (!messageBus) {
        /* Only reachable from a test that built an API without one. A plugin
           that declared the capability and got silence would be the worse
           failure, so this says which. */
        throw new Error(`plugin ${manifest.id} asked for messaging on a server with no message bus`);
      }
      return createMessaging(manifest.id, messageBus, prefixed);
    },

    get moderation(): PluginModeration {
      if (!capabilities.includes("moderation")) {
        throw new CapabilityError(manifest.id, "moderation", "moderation");
      }
      return moderation;
    },

    log: prefixed,
  };
}
