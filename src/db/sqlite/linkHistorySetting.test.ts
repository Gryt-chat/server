import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { createServerConfigIfNotExists, getServerConfig, updateServerConfig } from "./servers";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-link-history-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists({ displayName: "Somewhere" });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("holding linked devices' history (GRYT-2055)", () => {
  it("is on until the owner turns it off, and stays off", async () => {
    assert.equal((await getServerConfig())?.link_history_enabled, true);
    await updateServerConfig({ linkHistory: false });
    assert.equal((await getServerConfig())?.link_history_enabled, false);
    await updateServerConfig({ displayName: "Elsewhere" });
    assert.equal((await getServerConfig())?.link_history_enabled, false, "another change leaves it alone");
    await updateServerConfig({ linkHistory: true });
    assert.equal((await getServerConfig())?.link_history_enabled, true);
  });
});
