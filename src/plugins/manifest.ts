/**
 * A capability list is not a sandbox: a plugin runs in this process with the
 * whole Node runtime. It is what the operator reads before running it.
 */

/** Everything a plugin can ask for. Adding one means adding it here first. */
export const PLUGIN_CAPABILITIES = [
  /** Receive `message:created`. The text everybody on this server can already see. */
  "messages:read",
  /** Receive `member:joined` and `member:left`, with the invite code used. */
  "members:read",
  /** Everything with a victim. An entry only arrives here with the code that
      honours it, so nothing on the screen is agreeing to a no-op. */
  "moderation",
  /** Points the other way from the read capabilities: this one lets members
      send the plugin arbitrary bytes for it to parse. */
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
  /** Folder name by convention, and the key the log prefix, config section and
      storage namespace all hang off. */
  id: string;
  name: string;
  version: string;
  /** Entry point, relative to the plugin's own folder. */
  main: string;
  description?: string;
  author?: string;
  /** Members are shown this as a link, so `http` or `https` and nothing else:
      a `javascript:` URL here is an injection into every client. */
  homepage?: string;
  /** Normalised: deduplicated, in catalogue order, unknown names dropped. */
  capabilities: PluginCapability[];
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  /** Names the field: the operator is looking at somebody else's folder, and
      "invalid manifest" does not say which line to fix. */
  | { ok: false; reason: string };

function isCapability(value: unknown): value is PluginCapability {
  return (
    typeof value === "string" &&
    (PLUGIN_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Unknown names are dropped, not refused, so a plugin built against a newer
    Gryt still loads. Deduplicated and ordered, so it cannot be padded. */
export function declaredCapabilities(value: unknown): PluginCapability[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<PluginCapability>();
  for (const entry of value) {
    if (isCapability(entry)) seen.add(entry);
  }
  return PLUGIN_CAPABILITIES.filter((c) => seen.has(c));
}

/* An id becomes a path segment, so `..`, a slash and a leading dot are excluded
   here rather than by a check further down that a refactor could lose. */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/* Members see this and the plugin author wrote it, so `javascript:` would be an
   injection and `data:` a fake Gryt page. Parsed, never pattern-matched. */
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

/* Not semver: nothing sorts these. Short and printable so the log line saying
   what loaded is neither a lie nor a wall of text. */
const VERSION = /^[\w.+-]{1,32}$/;

function str(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Pure, so it tests without a folder. Everything is checked here because a
    manifest is read once and then trusted for the life of the process. */
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
  /* `main` is joined onto the plugin's folder. Weak on its own, but a manifest
     pointing at ../../etc is worth refusing rather than importing. */
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
