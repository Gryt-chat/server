import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { getUserByServerId, setUserAvatar, setUserWorn, upsertUser } from "./users";

/** A real database, like rename.test.ts: the column has to exist and a null has
    to survive the round trip rather than come back as an empty string. */
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-worn-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the look a member's owl is drawn in", () => {
  it("starts with nothing designed", async () => {
    const user = await upsertUser("key:aaa", "Alice");
    assert.equal(user.avatar_worn, null);

    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(stored?.avatar_worn, null);
  });

  it("stores and reads back a look", async () => {
    const user = await upsertUser("key:bbb", "Bob");
    await setUserWorn(user.server_user_id, "aiac----adab");

    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(stored?.avatar_worn, "aiac----adab");
  });

  it("clears back to nothing designed", async () => {
    const user = await upsertUser("key:ccc", "Carol");
    await setUserWorn(user.server_user_id, "aiac----adab");
    await setUserWorn(user.server_user_id, null);

    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(stored?.avatar_worn, null);
  });

  it("survives an avatar upload", async () => {
    // Saving a design uploads a PNG too, so an upload must not be taken to mean
    // somebody stopped using a designed look.
    const user = await upsertUser("key:ddd", "Dan");
    await setUserWorn(user.server_user_id, "aiac----adab");
    await setUserAvatar(user.server_user_id, "file_123");

    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(stored?.avatar_worn, "aiac----adab");
    assert.equal(stored?.avatar_file_id, "file_123");
  });

  it("survives a rejoin", async () => {
    // `upsertUser` runs on every join, so a wrong UPDATE here empties every
    // wardrobe on the next reconnect, silently.
    const user = await upsertUser("key:eee", "Erin");
    await setUserWorn(user.server_user_id, "aiac----adab");

    const rejoined = await upsertUser("key:eee", "Erin");
    assert.equal(rejoined.avatar_worn, "aiac----adab");
  });
});
