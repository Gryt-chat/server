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
    // The property that matters. The SFU memorises what a server registers
    // under its id and never forgets it, so a key that changed per boot would
    // be refused on every restart and voice would never come back.
    const first = getOrCreateSfuSecret();
    const second = getOrCreateSfuSecret();
    assert.equal(first, second);
  });

  it("does not travel with the server config", async () => {
    // server_config is read with SELECT * and mapped by rowToConfig, and that
    // record is what server:settings:get sends to every member. If this key
    // ever appears in it, every member of the server can mint their own SFU
    // token. Pinned here because the leak would be one careless field away and
    // nothing would look wrong.
    const secret = getOrCreateSfuSecret();
    const cfg = await getServerConfig();
    assert.ok(cfg);
    assert.ok(!JSON.stringify(cfg).includes(secret));
  });
});
