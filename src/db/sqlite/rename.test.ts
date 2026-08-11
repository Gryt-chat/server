import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { getUserByServerId, updateUserNickname, upsertUser } from "./users";

/**
 * Runs against a real database in a temporary directory rather than a stub,
 * because what is being tested is the SQL — the counter increments inside the
 * same UPDATE that does the rename, and the guard against counting a no-op is
 * a WHERE clause. A fake would only test the call.
 */
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-rename-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("rename visibility", () => {
  it("starts at never renamed", async () => {
    const user = await upsertUser("key:aaa", "Alice");
    assert.equal(user.nickname_change_count, 0);
    assert.equal(user.nickname_changed_at, null);
  });

  it("counts a real rename and stamps when", async () => {
    const user = await upsertUser("key:bbb", "Bob");
    await updateUserNickname(user.server_user_id, "Robert");

    const after = await getUserByServerId(user.server_user_id);
    assert.equal(after?.nickname, "Robert");
    assert.equal(after?.nickname_change_count, 1);
    assert.ok(after?.nickname_changed_at instanceof Date);
  });

  it("does not count setting the same name again", async () => {
    // The guard that matters. `profile:update` arrives for things that are not
    // renames, and a count that fires on those would accuse somebody who has
    // never renamed once.
    const user = await upsertUser("key:ccc", "Carol");
    await updateUserNickname(user.server_user_id, "Carol");
    await updateUserNickname(user.server_user_id, "Carol");

    const after = await getUserByServerId(user.server_user_id);
    assert.equal(after?.nickname_change_count, 0);
    assert.equal(after?.nickname_changed_at, null);
  });

  it("counts each further rename", async () => {
    const user = await upsertUser("key:ddd", "Dan");
    await updateUserNickname(user.server_user_id, "Daniel");
    await updateUserNickname(user.server_user_id, "Danny");

    const after = await getUserByServerId(user.server_user_id);
    assert.equal(after?.nickname_change_count, 2);
  });

  it("counts a rename back to a previous name", async () => {
    // Ends on the name it started with, so `nickname` alone cannot show that
    // anything happened. The count and the timestamp are what carry it.
    const user = await upsertUser("key:eee", "Erin");
    await updateUserNickname(user.server_user_id, "Impostor");
    await updateUserNickname(user.server_user_id, "Erin");

    const after = await getUserByServerId(user.server_user_id);
    assert.equal(after?.nickname, "Erin");
    assert.equal(after?.nickname_change_count, 2);
  });

  it("leaves other members alone", async () => {
    const a = await upsertUser("key:fff", "Fred");
    const b = await upsertUser("key:ggg", "Gina");
    await updateUserNickname(a.server_user_id, "Frederick");

    const other = await getUserByServerId(b.server_user_id);
    assert.equal(other?.nickname, "Gina");
    assert.equal(other?.nickname_change_count, 0);
  });
});
