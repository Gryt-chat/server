import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Guild } from "discord.js";

import { linkDiscordMember, setExcludedFromBridge } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { discordPresence } from "./presence";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-presence-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => rmSync(dir, { recursive: true, force: true }));

function member(id: string, status: string | null, bot = false) {
  return { id, displayName: `p${id.slice(-1)}`, user: { bot }, presence: status ? { status } : null, displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/a.png` };
}

describe("Discord people in the member list", () => {
  it("lists synced, unlinked people with their status, and leaves out bots", () => {
    linkDiscordMember("700000000000000002", "user_linked", "user_owner", "admin");
    setExcludedFromBridge("discord", "700000000000000003", true);
    const all = [member("700000000000000001", "dnd"), member("700000000000000002", "online"), member("700000000000000003", "online"), member("700000000000000004", "invisible"), member("700000000000000005", "online", true)];
    const guild = { members: { cache: new Map(all.map((m) => [m.id, m])) } } as unknown as Guild;
    assert.deepEqual(
      discordPresence(guild).map((p) => [p.discordUserId, p.status]),
      [["700000000000000001", "dnd"], ["700000000000000004", "offline"]],
    );
  });
});
