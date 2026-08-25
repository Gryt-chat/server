import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { getUserByServerId, setUserAvatar, setUserWorn, upsertUser } from "./users";

/**
 * A real database in a temporary directory, like rename.test.ts, and for the
 * same reason: what is being checked is that the column exists and that a null
 * survives the round trip as a null rather than as the empty string SQLite is
 * happy to hand back.
 */
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
    // The one that would break the editor if it were wrong. Saving a design
    // uploads a PNG as well — it is what an older client shows and where the
    // voice tile's colour comes from — so an upload must not be taken to mean
    // the person has stopped using a designed look.
    const user = await upsertUser("key:ddd", "Dan");
    await setUserWorn(user.server_user_id, "aiac----adab");
    await setUserAvatar(user.server_user_id, "file_123");

    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(stored?.avatar_worn, "aiac----adab");
    assert.equal(stored?.avatar_file_id, "file_123");
  });

  it("survives a rejoin", async () => {
    // `upsertUser` runs on every join and rewrites the row. It touches the
    // avatar and the timestamps by name, so the look should be untouched — but
    // this is the path a wrong UPDATE would empty every wardrobe on the next
    // reconnect, silently.
    const user = await upsertUser("key:eee", "Erin");
    await setUserWorn(user.server_user_id, "aiac----adab");

    const rejoined = await upsertUser("key:eee", "Erin");
    assert.equal(rejoined.avatar_worn, "aiac----adab");
  });
});
