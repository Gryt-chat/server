/**
 * Finding plugins on disk and starting them (GRYT-933).
 *
 * A plugin is a folder with a manifest.json and an entry point. No registry, no
 * install command: the operator puts a folder there, which is the honest
 * version of "run somebody else's code on your server" and matches how client
 * addons work. Anything resembling a registry would be a supply chain, and a
 * bad plugin here is not one person's client — it is everybody on that server
 * and the database.
 *
 * Nothing here is a security boundary. Loading a plugin is running its code
 * with this process's privileges. What this does is make the failures legible:
 * a folder that is not a plugin is named and skipped, a plugin that throws on
 * startup is named and skipped, and the rest of the server comes up either way.
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

/**
 * Read every plugin folder under `dir`.
 *
 * Never throws. A plugins directory that does not exist is the normal case —
 * almost nobody runs plugins — and an unreadable one is worth a line in the log
 * rather than a server that will not start.
 */
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
      /* A folder with no manifest at all is not a broken plugin, it is not a
         plugin — an editor's backup directory, a half-finished checkout. Saying
         so once is useful; treating it as a failure is noise. */
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

    /*
     * The manifest already refuses a `main` containing `..` or starting at the
     * root. This is the same check made again against the resolved path, which
     * is the one that is actually opened — a symlinked folder, or a platform
     * quirk in how the two are joined, could turn an innocent-looking relative
     * path into one that leaves. Cheap, and the alternative is trusting that
     * two string checks and a path join agree.
     */
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

/**
 * Where plugins live.
 *
 * Off unless `GRYT_PLUGINS_DIR` is set. A default path would mean a server
 * upgrade could start executing whatever happened to be in a directory the
 * operator had never thought about, which is the wrong way round for a feature
 * whose whole nature is running somebody else's code.
 */
export function pluginsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GRYT_PLUGINS_DIR?.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/*
 * Hidden from the bundler.
 *
 * `dist/bundle.js` is CommonJS, and esbuild rewrites a literal `import()` into
 * a require of something it tried to bundle at build time. A plugin does not
 * exist at build time, so the import has to be built where esbuild cannot see
 * it. Dynamic import rather than require, so a plugin may be written as either
 * ESM or CommonJS.
 */
const importPlugin: (path: string) => Promise<Record<string, unknown>> = new Function(
  "path",
  "return import(path)",
) as (path: string) => Promise<Record<string, unknown>>;

interface StartOptions {
  dir: string;
  /**
   * Called for each plugin that started, so members can be told what this
   * server runs (GRYT-941). Injected rather than imported so the loader has no
   * opinion about where that list lives.
   */
  announce?: (plugin: { id: string; version: string; capabilities: string[] }) => void;
  bus: PluginBus;
  /** Optional so a test can start plugins without one. The server passes one. */
  messageBus?: PluginMessageBus;
  logger: PluginLogger;
  /** Injected so the loader can be tested without importing real files. */
  load?: (entry: string) => Promise<Record<string, unknown>>;
}

/**
 * Load and start everything in the directory. Returns the ids that started.
 *
 * A plugin starts by exporting a function — `activate`, or a default export —
 * which is called with the API. Exporting nothing callable is allowed and does
 * nothing, because a plugin whose whole job is a side effect at import time is
 * a reasonable thing to write, if a hard one to debug.
 */
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
      /*
       * Every plugin that started, with what it may do. Not optional and not
       * configurable (GRYT-941): a member is the one whose messages are being
       * read, and knowing what code sits between them and the people they are
       * talking to is theirs to know. An operator who would rather it were not
       * seen is the case this exists for.
       *
       * After the load, so a plugin that failed to start is not announced —
       * saying it is here would send its client half talking to nothing, and
       * would tell a member about something that is not reading anything.
       */
      announce({
        id: manifest.id,
        version: manifest.version,
        capabilities: [...manifest.capabilities],
      });
      logger.info(
        `plugin ${manifest.id} ${manifest.version} started` +
          (manifest.capabilities.length
            ? ` (${manifest.capabilities.join(", ")})`
            : " (no capabilities declared)"),
      );
    } catch (err) {
      /*
       * A plugin that throws on startup is dropped and the server carries on.
       * The alternative — refusing to start — hands anybody who can write to
       * that folder a way to take the server down, and leaves an operator with
       * a server that will not boot because of a plugin they installed for fun.
       *
       * Anything it managed to subscribe before throwing is removed, so a
       * half-initialised plugin does not keep receiving events it is not ready
       * for.
       */
      bus.remove(manifest.id);
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logger.error(`plugin ${manifest.id} failed to start and was skipped: ${message}`);
    }
  }

  return started;
}
