/* eslint-disable @typescript-eslint/no-restricted-types -- the fake guild is cast through unknown; it only has what importRoles reads */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { PermissionFlagsBits, type Guild } from "discord.js";

import { ESCALATION_PERMISSIONS } from "../constants/permissions";
import { getRoleDefinition } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { grytPermissionsFor, importRoles } from "./roles";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-roles-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => rmSync(dir, { recursive: true, force: true }));

const role = (id: string, name: string, position: number, bits: bigint, managed = false) => ({
  id, name, position, managed, mentionable: false, color: 0x7c6ec3, hexColor: "#7c6ec3", permissions: { bitfield: bits },
});

describe("Discord roles", () => {
  it("never hands out the escalation permissions, not even to Administrator", () => {
    const all = grytPermissionsFor(PermissionFlagsBits.Administrator);
    assert.ok(all.includes("ban_members"));
    for (const p of ESCALATION_PERMISSIONS) assert.equal(all.includes(p as never), false, p);
    assert.deepEqual(grytPermissionsFor(PermissionFlagsBits.KickMembers).sort(), ["kick_members"]);
  });

  it("copies roles below Moderator in Discord's order, skipping @everyone and bot roles", async () => {
    const guild = {
      id: "100",
      roles: {
        fetch: async () =>
          new Map([
            ["100", role("100", "@everyone", 0, BigInt(0))],
            ["101", role("101", "Regulars", 1, PermissionFlagsBits.AttachFiles)],
            ["102", role("102", "Mods", 2, PermissionFlagsBits.KickMembers | PermissionFlagsBits.BanMembers)],
            ["103", role("103", "Some Bot", 3, PermissionFlagsBits.Administrator, true)],
          ]),
      },
    } as unknown as Guild;
    assert.equal(await importRoles(guild), 2);
    const regulars = await getRoleDefinition("dc-101");
    const mods = await getRoleDefinition("dc-102");
    assert.equal(regulars?.rank, 41);
    assert.equal(mods?.rank, 59);
    assert.equal(await getRoleDefinition("dc-103"), null);
    assert.equal(await importRoles(guild), 0);
  });
});
