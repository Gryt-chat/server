/**
 * A plugin is a folder with a manifest and an entry point. Nothing here is a
 * security boundary; it only makes the failures legible.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";

import { createPluginApi, type PluginLogger } from "./api";
import type { PluginBus } from "./bus";
import type { PluginMessageBus } from "./messaging";
import { readManifest, type PluginManifest } from "./manifest";

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** Absolute path to the entry point, already resolved against the folder. */
  entry: string;
  folder: string;
}

export interface Rejection {
  folder: string;
  reason: string;
}

export interface Discovery {
  plugins: DiscoveredPlugin[];
  rejected: Rejection[];
}

/** Never throws: a missing plugins directory is the normal case, and an
    unreadable one is a log line rather than a server that will not start. */
export function discoverPlugins(dir: string): Discovery {
  const plugins: DiscoveredPlugin[] = [];
  const rejected: Rejection[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return { plugins, rejected };
  }

  for (const name of entries) {
    const folder = join(dir, name);

    try {
      if (!statSync(folder).isDirectory()) continue;
    } catch {
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      /* No manifest at all is not a broken plugin, it is an editor's backup
         directory. Said once, not treated as a failure. */
      const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
      rejected.push({
        folder: name,
        reason: missing ? "no manifest.json" : `manifest.json could not be read: ${message}`,
      });
      continue;
    }

    const result = readManifest(raw);
    if (!result.ok) {
      rejected.push({ folder: name, reason: result.reason });
      continue;
    }

    /* The same check the manifest makes, against the resolved path that is
       actually opened: a symlink or a path-join quirk can differ. */
    const entry = resolve(folder, result.manifest.main);
    const inside = resolve(folder);
    if (!entry.startsWith(inside + "/") && entry !== inside) {
      rejected.push({ folder: name, reason: `main resolves outside the plugin folder` });
      continue;
    }

    /* Two folders claiming one id would share a storage namespace and a log
       prefix, and which one won would depend on directory order. */
    const clash = plugins.find((p) => p.manifest.id === result.manifest.id);
    if (clash) {
      rejected.push({
        folder: name,
        reason: `id ${result.manifest.id} is already used by ${clash.folder}`,
      });
      continue;
    }

    plugins.push({ manifest: result.manifest, entry, folder: name });
  }

  return { plugins, rejected };
}

/** Off unless `GRYT_PLUGINS_DIR` is set: a default path means an upgrade could
    execute whatever was in a directory nobody had thought about. */
export function pluginsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GRYT_PLUGINS_DIR?.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/* Hidden from esbuild, which rewrites a literal `import()` into a require of
   something it bundled. Dynamic import, so a plugin may be ESM or CommonJS. */
const importPlugin: (path: string) => Promise<Record<string, unknown>> = new Function(
  "path",
  "return import(path)",
) as (path: string) => Promise<Record<string, unknown>>;

interface StartOptions {
  dir: string;
  /** Injected rather than imported, so the loader has no opinion about where
      the announced list lives. */
  announce?: (plugin: {
    id: string;
    name: string;
    author?: string;
    description?: string;
    homepage?: string;
    capabilities: string[];
  }) => void;
  bus: PluginBus;
  /** Optional so a test can start plugins without one. The server passes one. */
  messageBus?: PluginMessageBus;
  logger: PluginLogger;
  /** Injected so the loader can be tested without importing real files. */
  load?: (entry: string) => Promise<Record<string, unknown>>;
}

/** A plugin starts by exporting `activate` or a default function. Exporting
    nothing callable is allowed: import-time side effects are legitimate. */
export async function startPlugins({
  dir,
  bus,
  messageBus,
  logger,
  announce = () => {},
  load = importPlugin,
}: StartOptions): Promise<string[]> {
  const { plugins, rejected } = discoverPlugins(dir);

  for (const { folder, reason } of rejected) {
    logger.warn(`plugin folder ${folder} skipped: ${reason}`);
  }

  const started: string[] = [];

  for (const { manifest, entry } of plugins) {
    try {
      const module = await load(entry);
      const activate = module.activate ?? module.default;

      if (typeof activate === "function") {
        await (activate as (api: unknown) => unknown)(
          createPluginApi(manifest, bus, logger, messageBus),
        );
      }

      started.push(manifest.id);
      /* Not configurable, after the load so a failed plugin is not announced,
         and without a version, which would name which known problem applies. */
      announce({
        id: manifest.id,
        name: manifest.name,
        author: manifest.author,
        description: manifest.description,
        homepage: manifest.homepage,
        capabilities: [...manifest.capabilities],
      });
      logger.info(
        `plugin ${manifest.id} ${manifest.version} started` +
          (manifest.capabilities.length
            ? ` (${manifest.capabilities.join(", ")})`
            : " (no capabilities declared)"),
      );
    } catch (err) {
      /* Dropped, not fatal: refusing to start hands anybody who can write to
         that folder a way to take the server down. Subscriptions go too. */
      bus.remove(manifest.id);
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logger.error(`plugin ${manifest.id} failed to start and was skipped: ${message}`);
    }
  }

  return started;
}
