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
import { pluginsDir, startPlugins } from "./host";

export type { PluginEvents, PluginEventName, PluginBus } from "./bus";
export { PLUGIN_CAPABILITIES, CAPABILITY_LABELS } from "./manifest";

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

const bus = createPluginBus(log);

/** What the emit sites call. Cheap and safe when no plugins are loaded. */
export function pluginEvents(): PluginBus {
  return bus;
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
    const started = await startPlugins({ dir, bus, logger: log });
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
