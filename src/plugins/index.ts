/**
 * Server plugins (GRYT-933).
 *
 * A plugin is a folder under `GRYT_PLUGINS_DIR` with a manifest.json and an
 * entry point, loaded into this process at startup. Unset the variable and
 * none of this runs, which is the default.
 *
 * **Installing a plugin is running somebody else's code on your server, with
 * your database.** The capability list is what a plugin says it intends to do,
 * so the operator can read it before they run it and so the log records it. It
 * is not a sandbox and there is no version of this where it is one and still
 * useful. `manifest.ts` says the same thing at more length, and the docs say it
 * to the person deciding whether to install one.
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

/*
 * One bus for the process.
 *
 * A module-level singleton rather than something threaded through every socket
 * handler, because the emit sites are scattered by nature — a message being
 * created, somebody joining — and passing a bus into each of them would be a
 * large diff through code that has nothing to do with plugins.
 *
 * It exists whether or not any plugin is loaded. `emit` with nothing subscribed
 * returns immediately, so the emit sites do not need to know whether plugins
 * are switched on.
 */
const log = {
  info: (m: string) => consola.info(m),
  warn: (m: string) => consola.warn(m),
  error: (m: string) => consola.error(m),
};

/*
 * One guard for the process, shared by both buses, so a plugin's failures add
 * up across everything that calls it rather than being counted twice at half
 * the rate (GRYT-939).
 */
const guard = createPluginGuard(log);
const bus = createPluginBus(log, guard);
const messages = createMessageBus(guard);

/** What the emit sites call. Cheap and safe when no plugins are loaded. */
export function pluginEvents(): PluginBus {
  return bus;
}

/**
 * What the socket handler calls when a client plugin sends something.
 *
 * Also answers whether anybody is listening, which is how a message for a
 * plugin this server does not run is refused before it is parsed.
 */
export function pluginMessages(): PluginMessageBus {
  return messages;
}

/**
 * Load whatever is in the plugins directory, if the operator set one.
 *
 * Never throws: a broken plugin folder must not be a server that will not
 * start. Everything it refuses is logged with the folder named.
 */
export async function initPlugins(): Promise<void> {
  const dir = pluginsDir();
  if (!dir) return;

  consola.info(`Loading plugins from ${dir}`);

  try {
    const started = await startPlugins({ dir, bus, messageBus: messages, logger: log });
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
