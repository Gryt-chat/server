/**
 * What a server plugin says it is, and what it says it wants (GRYT-933).
 *
 * ## This is not a sandbox, and it is further from one than the client's
 *
 * A plugin here is JavaScript the operator dropped in a folder, loaded into
 * this process. It has the Node runtime: the filesystem, the network, the
 * database file, the environment. `capabilities.ts` in the client makes the
 * same disclaimer, but there the worst case is one person's own client. Here
 * it is everybody on the server, and the database.
 *
 * So a capability list is not protection. What it is for:
 *
 * - the operator reads what a plugin intends before they run it
 * - `serverApi` refuses what was not declared, so a plugin that plays along is
 *   easy to write and one that does not has to reach around the API on purpose
 * - the declaration ends up in the logs, so "what is this server running" has
 *   an answer after the fact
 *
 * Installing a plugin is trusting whoever wrote it with the whole server.
 * Nothing in this file changes that and the docs should keep saying so.
 */

/** Everything a plugin can ask for. Adding one means adding it here first. */
export const PLUGIN_CAPABILITIES = [
  /** Receive `message:created`. The text everybody on this server can already see. */
  "messages:read",
  /** Receive `member:joined` and `member:left`, with the invite code used. */
  "members:read",
  /**
   * Kick and ban members (GRYT-935). Everything with a victim.
   *
   * Deleting a message is not in here yet and is GRYT-936: `chat:delete` does
   * six things inline and has to be pulled out before a second caller can have
   * it. The rule this catalogue follows is that an entry arrives with the code
   * that honours it — an operator reading "may delete messages" on a screen
   * must not be agreeing to something that does not exist.
   */
  "moderation",
  /**
   * Talk to the client half of this plugin (GRYT-939).
   *
   * Separate from the read capabilities because it points the other way. The
   * others let a plugin see what members do; this one lets members send it
   * arbitrary bytes, and an operator agreeing to it is agreeing to a plugin
   * that parses a stranger's input.
   */
  "messaging",
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** What each one lets a plugin do, in the words the operator reads. */
export const CAPABILITY_LABELS: Record<PluginCapability, string> = {
  "messages:read": "Read every message sent in a channel",
  "members:read": "See who joins and leaves, and the invite code they used",
  moderation: "Kick and ban members and delete their messages, but not a moderator's",
  messaging: "Exchange its own messages with the copy of itself in people's clients",
};

export interface PluginManifest {
  /**
   * Folder name by convention, and the key everything else hangs off: the log
   * prefix, the config section, the storage namespace.
   */
  id: string;
  name: string;
  version: string;
  /** Entry point, relative to the plugin's own folder. */
  main: string;
  description?: string;
  author?: string;
  /**
   * Where to go and read what this plugin is (GRYT-941).
   *
   * Members are told this, so it is checked rather than trusted: `http` or
   * `https` and nothing else. A `javascript:` or `data:` URL rendered as a link
   * in somebody's client is the reason this is not just a string.
   */
  homepage?: string;
  /** Normalised: deduplicated, in catalogue order, unknown names dropped. */
  capabilities: PluginCapability[];
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  /**
   * A refusal names the field, because the operator reading this is looking at
   * somebody else's folder and "invalid manifest" tells them nothing about
   * which line to go and fix.
   */
  | { ok: false; reason: string };

function isCapability(value: unknown): value is PluginCapability {
  return (
    typeof value === "string" &&
    (PLUGIN_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * The capabilities a manifest asks for, ignoring anything unrecognised.
 *
 * Unknown names are dropped rather than refused, so a plugin written against a
 * newer Gryt still loads on an older server and simply does not get the part
 * this build has never heard of. Refusing outright would take a working plugin
 * offline over a capability it may not even use yet.
 *
 * Deduplicated and ordered, so two manifests asking for the same things produce
 * the same list and a declaration cannot be padded or reordered into meaning
 * something different.
 */
export function declaredCapabilities(value: unknown): PluginCapability[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<PluginCapability>();
  for (const entry of value) {
    if (isCapability(entry)) seen.add(entry);
  }
  return PLUGIN_CAPABILITIES.filter((c) => seen.has(c));
}

/*
 * An id becomes a path segment — the storage namespace and the config key — so
 * it is kept to something that cannot climb out of one. `..`, a slash and a
 * leading dot are all excluded by this rather than by a check further down,
 * where a later refactor could lose them.
 */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/*
 * Only a link somebody can safely be shown.
 *
 * Members see this, and a plugin's manifest is written by whoever wrote the
 * plugin — so a `javascript:` URL here would be a link injection into every
 * member's client, and a `data:` one a way to serve them a page that looks like
 * Gryt. Parsed rather than pattern-matched, because a regex over URLs is how
 * that goes wrong.
 */
function readHomepage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || raw.length > 300) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/*
 * Not semver-strict. A plugin nobody publishes does not need a version anybody
 * can sort; this only has to be a short printable string so the log line saying
 * what loaded is not a lie or a wall of text.
 */
const VERSION = /^[\w.+-]{1,32}$/;

function str(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Read one `manifest.json`. Pure, so it can be tested without a folder.
 *
 * Everything is checked here rather than at use: a manifest is read once at
 * startup and then trusted for the life of the process, which is only safe if
 * "read" means "read and refused if wrong".
 */
export function readManifest(raw: unknown): ManifestResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "manifest.json is not an object" };
  }

  const source = raw as Record<string, unknown>;

  const id = str(source, "id");
  if (!id) return { ok: false, reason: "id is missing" };
  if (!ID.test(id)) {
    return {
      ok: false,
      reason: `id ${JSON.stringify(id)} must be lower case letters, digits, dot, dash or underscore, starting with a letter or digit`,
    };
  }

  const name = str(source, "name");
  if (!name) return { ok: false, reason: "name is missing" };

  const version = str(source, "version");
  if (!version) return { ok: false, reason: "version is missing" };
  if (!VERSION.test(version)) {
    return { ok: false, reason: `version ${JSON.stringify(version)} is not a short printable string` };
  }

  const main = str(source, "main");
  if (!main) return { ok: false, reason: "main is missing" };
  /*
   * `main` is joined onto the plugin's folder, so this is the check that keeps
   * a plugin from naming a file outside it. It is a weak defence on its own —
   * the plugin can read any file it likes once it is running — but a manifest
   * pointing at ../../etc is a manifest worth refusing to load, and saying so
   * is more use than importing it and finding out.
   */
  if (main.includes("..") || main.startsWith("/") || main.startsWith("\\")) {
    return { ok: false, reason: `main ${JSON.stringify(main)} must stay inside the plugin folder` };
  }

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      main,
      description: str(source, "description")?.slice(0, 200) ?? undefined,
      author: str(source, "author")?.slice(0, 80) ?? undefined,
      homepage: readHomepage(source.homepage),
      capabilities: declaredCapabilities(source.capabilities),
    },
  };
}
