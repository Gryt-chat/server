import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "./connection";
import { getUserByServerId, revokeUserSessions, upsertUser } from "./users";

/** The counter exists on the row, starts where a fresh token expects, and moves
    when revoked. The gates that compare it live elsewhere. */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-usertokenver-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the users table", () => {
  it("carries token_version", () => {
    const cols = (
      getSqliteDb().prepare("PRAGMA table_info(users)").all() as unknown as { name: string }[]
    ).map((c) => c.name);
    assert.ok(
      cols.includes("token_version"),
      "createSchema and the migration must both leave users with a token_version column",
    );
  });
});

describe("a member nobody has revoked", () => {
  it("starts at zero, which is what a token minted for them carries", async () => {
    const user = await upsertUser("gryt_user_quiet", "Quiet");
    assert.equal(user.token_version, 0);

    const read = await getUserByServerId(user.server_user_id);
    assert.equal(read?.token_version, 0, "the row must read back the way it was created");
  });
});

describe("revoking a member's sessions", () => {
  it("moves the counter, so a token minted before it no longer matches", async () => {
    const user = await upsertUser("gryt_user_revoked", "Revoked");
    const minted = user.token_version;

    await revokeUserSessions("gryt_user_revoked");

    const after = await getUserByServerId(user.server_user_id);
    assert.equal(after?.token_version, minted + 1);
    assert.notEqual(
      after?.token_version,
      minted,
      "a token carrying the old value has to stop matching, or nothing was revoked",
    );
  });

  it("moves it again, so revoking twice does not hand the first token back", async () => {
    const user = await upsertUser("gryt_user_twice", "Twice");

    await revokeUserSessions("gryt_user_twice");
    const once = (await getUserByServerId(user.server_user_id))?.token_version;
    await revokeUserSessions("gryt_user_twice");
    const twice = (await getUserByServerId(user.server_user_id))?.token_version;

    assert.equal(once, 1);
    assert.equal(twice, 2);
  });

  it("leaves everybody else alone", async () => {
    const kept = await upsertUser("gryt_user_bystander", "Bystander");
    await revokeUserSessions("gryt_user_revoked");

    const after = await getUserByServerId(kept.server_user_id);
    assert.equal(
      after?.token_version,
      kept.token_version,
      "revoking one member must not sign out the rest of the server -- that is what the server-wide counter is for",
    );
  });
});
