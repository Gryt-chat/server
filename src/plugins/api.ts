/**
 * The whole surface a plugin is handed. Small so that a plugin reaching outside
 * it is visible in its own source, not because it stops anything.
 */

import { createModerationActions, type PluginModeration } from "./actions";
import { createMessaging, type PluginMessageBus, type PluginMessaging } from "./messaging";
import type { PluginBus, PluginEventHandler, PluginEventName } from "./bus";
import type { PluginCapability, PluginManifest } from "./manifest";

/** Total rather than a lookup with a default, so a new event with no capability
    is a type error rather than one that quietly needs nothing. */
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
  /** Throws at subscribe rather than failing silently at delivery, so the stack
      trace at startup names the line. */
  on<E extends PluginEventName>(event: E, handler: PluginEventHandler<E>): void;
  /** Throws on access without the `moderation` capability, so a plugin finds
      out when it reaches for this, not on the first member it acts on. */
  readonly moderation: PluginModeration;
  /** What arrives here was written by a member's client, and the transport caps
      only size and rate. Do not assume your own client half sent it. */
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
      /* No entry means an event this build does not know, and defaulting to
         allowed makes a typo a free subscription. */
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
        /* Only reachable from a test that built an API without one. Silence
           after declaring the capability would be the worse failure. */
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
