import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { saveDiscordBridgeApp } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { discordAvatarLink } from "./avatarLink";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-avatar-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("member pictures on posts to Discord", () => {
  it("gives no link without a public https address", () => {
    saveDiscordBridgeApp("333333333333333333", "token-a");
    delete process.env.EXTERNAL_HOST;
    assert.equal(discordAvatarLink("user_a", "file_a"), undefined);
    process.env.EXTERNAL_HOST = "http://gryt.example";
    assert.equal(discordAvatarLink("user_a", "file_a"), undefined);
  });

  it("signs the link, and a new bot token gives a different one", () => {
    process.env.EXTERNAL_HOST = "gryt.example";
    const first = discordAvatarLink("user_a", "file_a");
    assert.match(first ?? "", /^https:\/\/gryt\.example\/api\/discord\/avatar\/user_a\/file_a\/[\w-]{32}\.png$/);
    assert.notEqual(discordAvatarLink("user_b", "file_a"), first);
    saveDiscordBridgeApp("333333333333333333", "token-b");
    assert.notEqual(discordAvatarLink("user_a", "file_a"), first);
  });
});
