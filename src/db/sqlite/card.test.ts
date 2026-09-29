import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { getUserByServerId, setUserCard, setUserWorn, upsertUser } from "./users";

/** A real database, like worn.test.ts: the columns have to exist and a null has
    to come back as a null. */
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-card-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a member's card", () => {
  it("starts empty", async () => {
    const user = await upsertUser("key:card-a", "Alice");
    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(user.card_style, null);
    assert.equal(stored?.card_style, null);
    assert.equal(stored?.bio, null);
    assert.equal(stored?.pronouns, null);
    assert.equal(stored?.status_line, null);
  });

  it("stores and reads back every field", async () => {
    const user = await upsertUser("key:card-b", "Bob");
    await setUserCard(user.server_user_id, {
      card_style: '{"pattern":"dots"}',
      bio: "Plays bass badly",
      pronouns: "he/him",
      status_line: "back at six",
    });
    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(stored?.card_style, '{"pattern":"dots"}');
    assert.equal(stored?.bio, "Plays bass badly");
    assert.equal(stored?.pronouns, "he/him");
    assert.equal(stored?.status_line, "back at six");
  });

  it("writes only the fields passed", async () => {
    const user = await upsertUser("key:card-c", "Carol");
    await setUserCard(user.server_user_id, { bio: "one", pronouns: "she/her" });
    await setUserCard(user.server_user_id, { bio: null });
    await setUserCard(user.server_user_id, {});
    const stored = await getUserByServerId(user.server_user_id);
    assert.equal(stored?.bio, null);
    assert.equal(stored?.pronouns, "she/her");
  });

  it("survives a rejoin and a new owl", async () => {
    // `upsertUser` runs on every join, so a wrong UPDATE there empties every card.
    const user = await upsertUser("key:card-d", "Dan");
    await setUserCard(user.server_user_id, { card_style: '{"fade":"banner"}', status_line: "hi" });
    await setUserWorn(user.server_user_id, "aiac----adab");
    const rejoined = await upsertUser("key:card-d", "Dan");
    assert.equal(rejoined.card_style, '{"fade":"banner"}');
    assert.equal(rejoined.status_line, "hi");
  });
});
