import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getServerChannel, setChannelLook, upsertServerChannel } from "./channels";
import { initSqlite } from "./connection";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-channel-look-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a channel's look", () => {
  it("is none on a new channel", async () => {
    await upsertServerChannel({ channelId: "c_look", name: "general", type: "text" });
    const c = await getServerChannel("c_look");
    assert.equal(c?.poster, null);
    assert.equal(c?.color, null);
  });

  it("stores a poster and colour, and an edit of the channel keeps them", async () => {
    assert.equal(await setChannelLook("c_look", { layout: "classic", fill: "solid", c1: "#5b4fd6", pattern: "contours" }, "#ffd27a"), true);
    await upsertServerChannel({ channelId: "c_look", name: "renamed", type: "text", description: "new topic" });
    const c = await getServerChannel("c_look");
    assert.deepEqual(c?.poster, { layout: "classic", fill: "solid", c1: "#5b4fd6", pattern: "contours" });
    assert.equal(c?.color, "#ffd27a");
    assert.equal(c?.name, "renamed");
  });

  it("clears both", async () => {
    await setChannelLook("c_look", null, null);
    const c = await getServerChannel("c_look");
    assert.equal(c?.poster, null);
    assert.equal(c?.color, null);
  });

  it("says when the channel doesn't exist", async () => {
    assert.equal(await setChannelLook("c_missing", null, null), false);
  });
});
