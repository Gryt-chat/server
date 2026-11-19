import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import sharp from "sharp";

import { initSqlite } from "../db/sqlite/connection";
import { getServerConfig } from "../db";
import { getObjectAsBuffer, initStorage, uploadsFolder } from "../storage";
import { setIcon } from "./setIcon";

let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-set-icon-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  initStorage();
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("setIcon", () => {
  it("stores a PNG as a 256px icon and points the config at it", async () => {
    const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#968ff8" } }).png().toBuffer();
    const result = await setIcon(png);
    assert.ok(result.ok, result.ok ? "" : result.message);

    assert.equal((await getServerConfig())?.icon_url, result.key);
    const stored = await getObjectAsBuffer({ bucket: uploadsFolder(), key: result.key });
    const meta = await sharp(stored).metadata();
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 256);
  });

  it("goes by the bytes, so a renamed text file is refused", async () => {
    const before = (await getServerConfig())?.icon_url;
    const result = await setIcon(Buffer.from("<svg onload=alert(1)>"));
    assert.equal(result.ok, false);
    assert.equal((await getServerConfig())?.icon_url, before);
  });
});
