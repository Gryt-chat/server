import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Request, Response } from "express";

import { createServerConfigIfNotExists, setServerOwner, setServerRole } from "../db";
import { initSqlite } from "../db/sqlite/connection";
import { requireOwner } from "./discordImport";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-discord-import-route-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await setServerOwner("gryt_owner");
  // An admin holds every permission a role can give, and still isn't the owner.
  await setServerRole("user_admin", "admin");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function gate(serverUserId: string | undefined, grytUserId?: string): Promise<{ status: number | null; passed: boolean }> {
  let status: number | null = null;
  let passed = false;
  const req = { tokenPayload: serverUserId ? { serverUserId, grytUserId } : undefined } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  await requireOwner(req, res, () => {
    passed = true;
  });
  return { status, passed };
}

describe("who can start a Discord import", () => {
  it("lets the owner through", async () => {
    assert.deepEqual(await gate("user_owner", "gryt_owner"), { status: null, passed: true });
  });

  it("turns an admin away", async () => {
    assert.deepEqual(await gate("user_admin", "gryt_admin"), { status: 403, passed: false });
  });

  it("turns away a request with no identity", async () => {
    assert.deepEqual(await gate(undefined), { status: 401, passed: false });
  });
});
