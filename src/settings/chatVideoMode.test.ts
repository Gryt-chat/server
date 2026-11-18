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
  dir = mkdtempSync(join(tmpdir(), "gryt-chat-video-mode-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("video uploads setting (GRYT-2159)", () => {
  it("starts on original, takes the three modes and ignores anything else", async () => {
    const cfg = await getServerConfig();
    assert.ok(cfg);
    assert.equal(cfg.chat_video_mode, "original");
    assert.equal(settingsView(cfg, "s", true).chatVideoMode, "original");

    const small = await applyServerSettings({ chatVideoMode: "small" }, { serverUserId: null, via: "management" });
    assert.equal(small.chat_video_mode, "small");

    const junk = await applyServerSettings({ chatVideoMode: "4k" }, { serverUserId: null, via: "management" });
    assert.equal(junk.chat_video_mode, "small");

    const balanced = await applyServerSettings({ chatVideoMode: "balanced" }, { serverUserId: null, via: "management" });
    assert.equal(settingsView(balanced, "s", true).chatVideoMode, "balanced");
  });
});
