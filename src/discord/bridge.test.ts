import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { PermissionFlagsBits } from "discord.js";

import { clearDiscordBridge, getDiscordBridge, saveDiscordBridgeApp, updateDiscordBridge } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { BRIDGE_PERMISSIONS, inviteUrl, statusForCloseCode } from "./bridge";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-bridge-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("discord bridge", () => {
  it("never asks for Administrator", () => {
    assert.equal(BRIDGE_PERMISSIONS & PermissionFlagsBits.Administrator, BigInt(0));
    const url = new URL(inviteUrl("123456789012345678"));
    assert.equal(url.searchParams.get("client_id"), "123456789012345678");
    assert.equal(url.searchParams.get("permissions"), BRIDGE_PERMISSIONS.toString());
  });

  it("stops on the close codes reconnecting can't fix", () => {
    assert.equal(statusForCloseCode(4004), "token_invalid");
    assert.equal(statusForCloseCode(4014), "intents_missing");
    assert.equal(statusForCloseCode(1006), null);
  });

  it("keeps the linked server when a new token is pasted", () => {
    saveDiscordBridgeApp("111111111111111111", "old-token");
    updateDiscordBridge({ status: "linked", guild_id: "222222222222222222", guild_name: "Night Owls" });
    saveDiscordBridgeApp("111111111111111111", "new-token");

    const b = getDiscordBridge();
    assert.equal(b?.bot_token, "new-token");
    assert.equal(b?.guild_id, "222222222222222222");
    assert.equal(b?.status, "connecting");

    clearDiscordBridge();
    assert.equal(getDiscordBridge(), null);
  });
});
