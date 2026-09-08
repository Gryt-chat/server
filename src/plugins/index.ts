/**
 * A folder under `GRYT_PLUGINS_DIR`, loaded into this process at startup. Unset
 * the variable and none of this runs, which is the default.
 */

import { consola } from "consola";

import { createPluginBus, type PluginBus } from "./bus";
import { createPluginGuard } from "./guard";
import { pluginsDir, startPlugins } from "./host";
import { createMessageBus, type PluginMessageBus } from "./messaging";

export type { PluginEvents, PluginEventName, PluginBus } from "./bus";
export { PLUGIN_CAPABILITIES, CAPABILITY_LABELS } from "./manifest";
export { PLUGIN_MESSAGE_EVENT } from "./messaging";
export type { IncomingPluginMessage } from "./messaging";

/* One bus for the process, so the scattered emit sites do not have to thread
   one through. `emit` with nothing subscribed returns immediately. */
const log = {
  info: (m: string) => consola.info(m),
  warn: (m: string) => consola.warn(m),
  error: (m: string) => consola.error(m),
};

/* Shared by both buses, so a plugin's failures add up rather than being counted
   twice at half the rate. */
const guard = createPluginGuard(log);
const bus = createPluginBus(log, guard);
const messages = createMessageBus(guard);

/** What the emit sites call. Cheap and safe when no plugins are loaded. */
export function pluginEvents(): PluginBus {
  return bus;
}

/* Written once at startup and read on every join. A plain array, because
   plugins do not load or unload while the server is running. */
export interface AnnouncedPlugin {
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** Where to read about it. Already checked to be http or https. */
  homepage?: string;
  capabilities: string[];
}

const announced: AnnouncedPlugin[] = [];

/** Carries the capabilities, so a member can read what a plugin reads and
    decide whether to stay. No version: that names which known problem applies. */
export function announcedPlugins(): readonly AnnouncedPlugin[] {
  return announced;
}

/** Also answers whether anybody is listening, so a message for a plugin this
    server does not run is refused before it is parsed. */
export function pluginMessages(): PluginMessageBus {
  return messages;
}

/** Never throws: a broken plugin folder must not be a server that will not
    start. Everything refused is logged with the folder named. */
export async function initPlugins(): Promise<void> {
  const dir = pluginsDir();
  if (!dir) return;

  consola.info(`Loading plugins from ${dir}`);

  try {
    const started = await startPlugins({
      dir,
      bus,
      messageBus: messages,
      logger: log,
      announce: (plugin) => void announced.push(plugin),
    });
    if (started.length === 0) {
      consola.info("No plugins loaded");
      return;
    }
    consola.success(
      `${started.length} plugin${started.length === 1 ? "" : "s"} loaded: ${started.join(", ")}`,
    );
  } catch (err) {
    /* startPlugins already contains a plugin's own failures, so reaching here
       means the loader itself broke. Still not worth refusing to boot over. */
    consola.error("Plugin loading failed; continuing without plugins", err);
  }
}
