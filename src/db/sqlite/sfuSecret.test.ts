import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { createServerConfigIfNotExists, getOrCreateSfuSecret, getServerConfig } from "./servers";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-sfu-secret-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the SFU signing key", () => {
  it("is generated rather than left empty", () => {
    const secret = getOrCreateSfuSecret();
    assert.notEqual(secret, "");
    // 32 bytes as hex. Short enough to eyeball, long enough that the length is
    // the thing being pinned rather than the exact value.
    assert.equal(secret.length, 64);
  });

  it("is the same on the next call", () => {
    // The SFU memorises what a server registered under its id, so a key that
    // changed per boot is refused on every restart and voice never comes back.
    const first = getOrCreateSfuSecret();
    const second = getOrCreateSfuSecret();
    assert.equal(first, second);
  });

  it("does not travel with the server config", async () => {
    // `rowToConfig` is what `server:settings:get` sends to every member, so this
    // key appearing there lets any of them mint their own SFU token.
    const secret = getOrCreateSfuSecret();
    const cfg = await getServerConfig();
    assert.ok(cfg);
    assert.ok(!JSON.stringify(cfg).includes(secret));
  });
});
