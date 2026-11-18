import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists } from "../db/sqlite/servers";
import { applyServerSettings, settingsView } from "./serverSettings";
import { effectiveVideoCeiling, parseVideoCeiling, videoCeilingCapability } from "./videoCeiling";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-video-ceiling-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  delete process.env.GRYT_PLAN_VIDEO_MAX;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe("video ceiling (GRYT-2171)", () => {
  it("reads 1080p60 and 720p30, and nothing else", () => {
    assert.deepEqual(parseVideoCeiling("1080p60"), { maxHeight: 1080, maxFps: 60, maxKbps: 12184 });
    assert.equal(parseVideoCeiling("720p30")?.maxKbps, 3750);
    for (const bad of ["", "1080", "999p60", "1080p0", "1080p999", "4k", null, 1080]) {
      assert.equal(parseVideoCeiling(bad), null, String(bad));
    }
    assert.equal(videoCeilingCapability(parseVideoCeiling("720p30")), "video_max_kbps:3750");
    assert.equal(videoCeilingCapability(null), null);
  });

  it("is none on a self-hosted server, and the stored value wins over the env", () => {
    delete process.env.GRYT_PLAN_VIDEO_MAX;
    assert.equal(effectiveVideoCeiling(null), null);
    process.env.GRYT_PLAN_VIDEO_MAX = "1080p60";
    assert.equal(effectiveVideoCeiling(null)?.maxHeight, 1080);
    assert.equal(effectiveVideoCeiling("720p30")?.maxHeight, 720);
  });

  it("can only be changed through management, never by the owner", async () => {
    process.env.GRYT_PLAN_VIDEO_MAX = "1080p60";
    const fromClient = await applyServerSettings({ planVideoMax: "1440p60" }, { serverUserId: "owner", via: "client" });
    assert.equal(fromClient.plan_video_max, null);
    assert.equal(settingsView(fromClient, "s", true).videoMax?.maxHeight, 1080);

    const lowered = await applyServerSettings({ planVideoMax: "720p30" }, { serverUserId: null, via: "management" });
    assert.equal(settingsView(lowered, "s", true).videoMax?.maxHeight, 720);

    const junk = await applyServerSettings({ planVideoMax: "huge" }, { serverUserId: null, via: "management" });
    assert.equal(junk.plan_video_max, "720p30");

    const back = await applyServerSettings({ planVideoMax: null }, { serverUserId: null, via: "management" });
    assert.equal(settingsView(back, "s", true).videoMax?.maxHeight, 1080);
  });
});
