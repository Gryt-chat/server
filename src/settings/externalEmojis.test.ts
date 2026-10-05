import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists, getServerConfig } from "../db/sqlite/servers";
import { applyServerSettings, settingsView } from "./serverSettings";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-ext-emoji-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("other servers' emoji (GRYT-1660)", () => {
  it("is off until the owner turns it on, and stays as set", async () => {
    const cfg = await getServerConfig();
    assert.ok(cfg);
    assert.equal(cfg.external_emojis_enabled, false);
    assert.equal(settingsView(cfg, "s", true).externalEmojis, false);

    const on = await applyServerSettings({ externalEmojis: true }, { serverUserId: null, via: "management" });
    assert.equal(on.external_emojis_enabled, true);
    assert.equal(settingsView(on, "s", true).externalEmojis, true);

    // Leaving it out of a patch changes nothing, and anything but a boolean is ignored.
    const untouched = await applyServerSettings({ displayName: "Elsewhere" }, { serverUserId: null, via: "management" });
    assert.equal(untouched.external_emojis_enabled, true);
    const junk = await applyServerSettings({ externalEmojis: "yes" as unknown as boolean }, { serverUserId: null, via: "management" });
    assert.equal(junk.external_emojis_enabled, true);

    const off = await applyServerSettings({ externalEmojis: false }, { serverUserId: null, via: "management" });
    assert.equal(off.external_emojis_enabled, false);
  });
});
