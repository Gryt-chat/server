import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import { createPluginApi, CapabilityError, EVENT_CAPABILITY } from "./api";
import { createPluginBus, type BusLogger } from "./bus";
import { PLUGIN_CAPABILITIES } from "./manifest";
import { discoverPlugins, pluginsDir, startPlugins } from "./host";

/**
 * Finding plugins on disk, and what happens when one of them is not (GRYT-933).
 *
 * None of this is a security boundary — loading a plugin runs its code with
 * this process's privileges. What is being checked is that every way a folder
 * can fail to be a plugin is named and skipped, and that the server comes up
 * regardless. An operator debugging their own plugin at midnight is the reader.
 */

let dir = "";

function logger() {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    info: (m: string) => lines.push({ level: "info", message: m }),
    warn: (m: string) => lines.push({ level: "warn", message: m }),
    error: (m: string) => lines.push({ level: "error", message: m }),
    at: (level: string) => lines.filter((l) => l.level === level).map((l) => l.message),
  };
}

function plugin(folder: string, manifest: unknown, entry = "index.js") {
  const path = join(dir, folder);
  mkdirSync(path, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(
      join(path, "manifest.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  writeFileSync(join(path, entry), "export function activate() {}\n");
  return path;
}

const manifestFor = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  version: "1.0.0",
  main: "index.js",
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gryt-plugins-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("discovering plugins", () => {
  it("finds one", () => {
    plugin("automod", manifestFor("automod"));

    const { plugins, rejected } = discoverPlugins(dir);

    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].manifest.id, "automod");
    assert.equal(plugins[0].entry, join(dir, "automod", "index.js"));
    assert.deepEqual(rejected, []);
  });

  it("finds several, in a stable order", () => {
    plugin("zeta", manifestFor("zeta"));
    plugin("alpha", manifestFor("alpha"));

    assert.deepEqual(
      discoverPlugins(dir).plugins.map((p) => p.manifest.id),
      ["alpha", "zeta"],
      "directory order reached the caller, so load order would vary by filesystem",
    );
  });

  /* Almost nobody runs plugins, so this is the normal case rather than an
     error. A server that would not start without the directory would be a
     server that stopped starting on upgrade. */
  it("is empty and quiet when the directory does not exist", () => {
    const { plugins, rejected } = discoverPlugins(join(dir, "nope"));
    assert.deepEqual(plugins, []);
    assert.deepEqual(rejected, []);
  });

  it("ignores a loose file next to the folders", () => {
    plugin("automod", manifestFor("automod"));
    writeFileSync(join(dir, "notes.txt"), "hello");

    const { plugins, rejected } = discoverPlugins(dir);
    assert.equal(plugins.length, 1);
    assert.deepEqual(rejected, []);
  });
});

describe("a folder that is not a plugin", () => {
  it("is named, and says the manifest is missing", () => {
    mkdirSync(join(dir, "half-a-checkout"));

    const { plugins, rejected } = discoverPlugins(dir);

    assert.deepEqual(plugins, []);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].folder, "half-a-checkout");
    assert.match(rejected[0].reason, /no manifest\.json/);
  });

  it("distinguishes unreadable from missing", () => {
    plugin("broken", "{ not json");

    const { rejected } = discoverPlugins(dir);

    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /could not be read/);
    assert.doesNotMatch(rejected[0].reason, /no manifest\.json/);
  });

  it("passes the manifest's own reason through, field named", () => {
    plugin("nameless", { id: "nameless", version: "1.0.0", main: "index.js" });

    const { rejected } = discoverPlugins(dir);

    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /name/);
  });

  it("does not stop the good ones loading", () => {
    plugin("broken", "{ not json");
    plugin("fine", manifestFor("fine"));

    const { plugins, rejected } = discoverPlugins(dir);

    assert.deepEqual(plugins.map((p) => p.manifest.id), ["fine"]);
    assert.equal(rejected.length, 1);
  });
});

/*
 * The manifest already refuses a `main` with `..` in it. This is the same
 * question asked of the path that is actually opened, which a symlink can
 * answer differently.
 */
describe("an entry point that leaves the folder", () => {
  it("is refused when the path resolves outside", () => {
    const outside = join(dir, "outside.js");
    writeFileSync(outside, "");
    const path = join(dir, "escapee");
    mkdirSync(path);
    /* Written directly rather than through readManifest, because readManifest
       would refuse it first — this is the second check, and it has to be
       reachable to be worth having. */
    writeFileSync(
      join(path, "manifest.json"),
      JSON.stringify({ id: "escapee", name: "e", version: "1", main: "sub/../../outside.js" }),
    );

    const { plugins, rejected } = discoverPlugins(dir);

    assert.deepEqual(plugins, []);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /outside/);
  });

  it("allows a file in a subfolder of its own", () => {
    const path = join(dir, "nested");
    mkdirSync(join(path, "dist"), { recursive: true });
    writeFileSync(join(path, "manifest.json"), JSON.stringify(manifestFor("nested", { main: "dist/index.js" })));
    writeFileSync(join(path, "dist", "index.js"), "");

    assert.equal(discoverPlugins(dir).plugins.length, 1);
  });
});

describe("two folders claiming one id", () => {
  it("keeps the first and names the second", () => {
    plugin("a-copy", manifestFor("automod"));
    plugin("b-copy", manifestFor("automod"));

    const { plugins, rejected } = discoverPlugins(dir);

    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].folder, "a-copy");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /already used by a-copy/);
  });
});

describe("where plugins live", () => {
  it("is nowhere unless the operator says", () => {
    assert.equal(pluginsDir({}), null);
    assert.equal(pluginsDir({ GRYT_PLUGINS_DIR: "  " }), null);
  });

  it("takes an absolute path as given", () => {
    assert.equal(pluginsDir({ GRYT_PLUGINS_DIR: "/srv/plugins" }), "/srv/plugins");
  });

  it("resolves a relative one against the working directory", () => {
    const result = pluginsDir({ GRYT_PLUGINS_DIR: "plugins" });
    assert.equal(result, join(process.cwd(), "plugins"));
  });
});

describe("starting them", () => {
  it("calls activate with the api and reports what started", async () => {
    plugin("automod", manifestFor("automod", { capabilities: ["messages:read"] }));
    const log = logger();
    const bus = createPluginBus(log as BusLogger);
    let gotId = "";

    const started = await startPlugins({
      dir,
      bus,
      logger: log,
      load: async () => ({
        activate: (api: { id: string; on: (e: string, h: () => void) => void }) => {
          gotId = api.id;
          api.on("message:created", () => {});
        },
      }),
    });

    assert.deepEqual(started, ["automod"]);
    assert.equal(gotId, "automod");
    assert.deepEqual(bus.stats().plugins, ["automod"]);
  });

  it("accepts a default export instead of activate", async () => {
    plugin("automod", manifestFor("automod"));
    const log = logger();
    let called = false;

    await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      load: async () => ({ default: () => void (called = true) }),
    });

    assert.equal(called, true);
  });

  it("allows a plugin that exports nothing callable", async () => {
    plugin("sideeffect", manifestFor("sideeffect"));
    const log = logger();

    const started = await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      load: async () => ({}),
    });

    assert.deepEqual(started, ["sideeffect"]);
  });

  it("waits for an async activate before calling it started", async () => {
    plugin("slow", manifestFor("slow"));
    const log = logger();
    let finished = false;

    await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      load: async () => ({
        activate: async () => {
          await new Promise((r) => setTimeout(r, 5));
          finished = true;
        },
      }),
    });

    assert.equal(finished, true);
  });
});

/*
 * The failure an operator will actually hit. Refusing to start the server
 * instead would hand anybody who can write to that folder a way to take it
 * down, and leave somebody with a server that will not boot over a plugin they
 * installed for fun.
 */
describe("announcing a plugin to members", () => {
  it("does not, unless the manifest asked", async () => {
    plugin("quiet", manifestFor("quiet"));
    const log = logger();
    const announced: { id: string; version: string }[] = [];

    await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      announce: (p) => void announced.push(p),
      load: async () => ({}),
    });

    assert.deepEqual(announced, []);
  });

  it("does when it did", async () => {
    plugin("presence", manifestFor("presence", { public: true, version: "2.1.0" }));
    const log = logger();
    const announced: { id: string; version: string }[] = [];

    await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      announce: (p) => void announced.push(p),
      load: async () => ({}),
    });

    assert.deepEqual(announced, [{ id: "presence", version: "2.1.0" }]);
  });

  /* A plugin that failed to start is not here, so saying it is would send its
     client half talking to nothing. */
  it("does not announce one that failed to start", async () => {
    plugin("broken", manifestFor("broken", { public: true }));
    const log = logger();
    const announced: { id: string; version: string }[] = [];

    await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      announce: (p) => void announced.push(p),
      load: async () => {
        throw new Error("boom");
      },
    });

    assert.deepEqual(announced, []);
  });
});

describe("a plugin that throws on startup", () => {
  it("is skipped, and the server carries on", async () => {
    plugin("broken", manifestFor("broken"));
    plugin("fine", manifestFor("fine"));
    const log = logger();

    const started = await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      load: async (entry) => {
        if (entry.includes("broken")) throw new Error("boom");
        return {};
      },
    });

    assert.deepEqual(started, ["fine"]);
    assert.equal(log.at("error").length, 1);
    assert.match(log.at("error")[0], /broken/);
    assert.match(log.at("error")[0], /boom/);
  });

  it("loses whatever it subscribed before it threw", async () => {
    plugin("halfway", manifestFor("halfway", { capabilities: ["messages:read"] }));
    const log = logger();
    const bus = createPluginBus(log as BusLogger);

    await startPlugins({
      dir,
      bus,
      logger: log,
      load: async () => ({
        activate: (api: { on: (e: string, h: () => void) => void }) => {
          api.on("message:created", () => {});
          throw new Error("second half failed");
        },
      }),
    });

    assert.deepEqual(
      bus.stats(),
      { plugins: [], disabled: [], subscriptions: 0 },
      "a plugin that failed to start kept receiving events",
    );
  });

  it("survives a rejection as well as a throw", async () => {
    plugin("broken", manifestFor("broken"));
    const log = logger();

    const started = await startPlugins({
      dir,
      bus: createPluginBus(log as BusLogger),
      logger: log,
      load: async () => ({ activate: async () => Promise.reject(new Error("async boom")) }),
    });

    assert.deepEqual(started, []);
    assert.match(log.at("error")[0], /async boom/);
  });
});

describe("what the api lets a plugin do", () => {
  it("maps every event to a capability", () => {
    for (const [event, capability] of Object.entries(EVENT_CAPABILITY)) {
      assert.ok(
        (PLUGIN_CAPABILITIES as readonly string[]).includes(capability),
        `${event} needs ${capability}, which is not in the catalogue`,
      );
    }
  });

  it("refuses an event the manifest did not ask for", () => {
    const log = logger();
    const bus = createPluginBus(log as BusLogger);
    const api = createPluginApi(
      { id: "a", name: "a", version: "1", main: "i.js", public: false, capabilities: ["members:read"] },
      bus,
      log,
    );

    assert.throws(() => api.on("message:created", () => {}), CapabilityError);
    assert.deepEqual(bus.stats().plugins, []);
  });

  it("allows one it did", () => {
    const log = logger();
    const bus = createPluginBus(log as BusLogger);
    const api = createPluginApi(
      { id: "a", name: "a", version: "1", main: "i.js", public: false, capabilities: ["messages:read"] },
      bus,
      log,
    );

    api.on("message:created", () => {});
    assert.deepEqual(bus.stats().plugins, ["a"]);
  });

  /* A typo in an event name would otherwise be a free subscription that never
     fires — the worst kind of bug to find, because nothing says anything. */
  it("refuses an event this build has never heard of", () => {
    const log = logger();
    const api = createPluginApi(
      { id: "a", name: "a", version: "1", main: "i.js", public: false, capabilities: [...PLUGIN_CAPABILITIES] },
      createPluginBus(log as BusLogger),
      log,
    );

    assert.throws(
      () => (api.on as (e: string, h: () => void) => void)("message:deleted", () => {}),
      CapabilityError,
    );
  });

  it("prefixes the plugin's log lines with its id", () => {
    const log = logger();
    const api = createPluginApi(
      { id: "automod", name: "a", version: "1", main: "i.js", public: false, capabilities: [] },
      createPluginBus(log as BusLogger),
      log,
    );

    api.log.info("banned somebody");

    assert.equal(log.at("info")[0], "[automod] banned somebody");
  });

  /*
   * Thrown on the property rather than returned as a refusal from each call. A
   * plugin should find out it was not given this when it reaches for it, at
   * startup, not on the first member it tries to act on at three in the
   * morning.
   */
  it("refuses moderation to a plugin that did not declare it", () => {
    const log = logger();
    const api = createPluginApi(
      { id: "a", name: "a", version: "1", main: "i.js", public: false, capabilities: ["messages:read"] },
      createPluginBus(log as BusLogger),
      log,
    );

    assert.throws(() => api.moderation, CapabilityError);
  });

  it("hands it over to a plugin that did", () => {
    const log = logger();
    const api = createPluginApi(
      { id: "a", name: "a", version: "1", main: "i.js", public: false, capabilities: ["moderation"] },
      createPluginBus(log as BusLogger),
      log,
    );

    assert.equal(typeof api.moderation.kick, "function");
    assert.equal(typeof api.moderation.ban, "function");
  });

  it("says which capability was missing, not just that one was", () => {
    const log = logger();
    const api = createPluginApi(
      { id: "watcher", name: "a", version: "1", main: "i.js", public: false, capabilities: [] },
      createPluginBus(log as BusLogger),
      log,
    );

    assert.throws(
      () => api.moderation,
      (err: Error) => /watcher/.test(err.message) && /moderation/.test(err.message),
    );
  });

  it("does not let a plugin edit its own capability list", () => {
    const log = logger();
    const api = createPluginApi(
      { id: "a", name: "a", version: "1", main: "i.js", public: false, capabilities: ["members:read"] },
      createPluginBus(log as BusLogger),
      log,
    );

    assert.throws(() => (api.capabilities as string[]).push("messages:read"));
    assert.deepEqual([...api.capabilities], ["members:read"]);
  });
});
