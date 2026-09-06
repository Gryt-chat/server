import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { initPlugins, pluginEvents } from "./index";

/**
 * That the bus a plugin subscribes to is the bus the server emits on (GRYT-933).
 *
 * Everything else in this folder tests a bus somebody handed in. The emit sites
 * — chat.ts, join.ts, evict.ts — call `pluginEvents()` instead, and if that ever
 * returned a second bus every unit test here would still pass while no plugin
 * ever heard anything. There is no failure this module can produce that looks
 * more like working software than that one.
 */

const dir = mkdtempSync(join(tmpdir(), "gryt-wiring-"));

after(() => rmSync(dir, { recursive: true, force: true }));

/* A real plugin, written to disk and imported the way the loader imports one,
   rather than a stub handed to startPlugins. */
function writePlugin(id: string, body: string) {
  const folder = join(dir, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      main: "index.mjs",
      capabilities: ["messages:read", "members:read"],
    }),
  );
  writeFileSync(join(folder, "index.mjs"), body);
}

describe("a plugin loaded the way the server loads one", () => {
  it("receives what the server emits", async () => {
    writePlugin(
      "spy",
      `globalThis.__grytSpy = [];
       export function activate(api) {
         api.on("message:created", (m) => globalThis.__grytSpy.push(m.text));
         api.on("member:joined", (m) => globalThis.__grytSpy.push("joined:" + m.inviteCode));
       }`,
    );

    process.env.GRYT_PLUGINS_DIR = dir;
    await initPlugins();
    delete process.env.GRYT_PLUGINS_DIR;

    pluginEvents().emit("message:created", {
      messageId: "m1",
      channelId: "c1",
      userId: "u1",
      nickname: "Sivert",
      text: "hello",
      attachmentCount: 0,
      at: new Date().toISOString(),
    });
    pluginEvents().emit("member:joined", {
      userId: "u2",
      nickname: "New",
      inviteCode: "abc123",
      at: new Date().toISOString(),
    });

    assert.deepEqual(
      (globalThis as { __grytSpy?: string[] }).__grytSpy,
      ["hello", "joined:abc123"],
      "the plugin subscribed to a different bus than the one the server emits on",
    );
  });

  it("is switched off unless the operator names a directory", async () => {
    delete process.env.GRYT_PLUGINS_DIR;
    const before = pluginEvents().stats().subscriptions;

    await initPlugins();

    assert.equal(pluginEvents().stats().subscriptions, before);
  });
});
