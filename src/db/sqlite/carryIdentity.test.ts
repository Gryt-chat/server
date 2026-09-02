import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import {
  claimServerOwner,
  getServerConfig,
  setServerRole,
  listMemberRoles,
} from "./servers";
import { carryIdentityForward, getUserByGrytId, upsertUser } from "./users";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-carry-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("carrying an identity forward", () => {
  it("moves the membership to the account", async () => {
    const local = await upsertUser("key:aaa", "Ada");
    await setServerRole(local.server_user_id, "admin");

    const carried = await carryIdentityForward("key:aaa", "account-1");

    assert.deepEqual(carried, { status: "carried" });
    assert.equal(await getUserByGrytId("key:aaa"), null);

    const now = await getUserByGrytId("account-1");
    assert.equal(now?.server_user_id, local.server_user_id, "same membership");
    assert.equal(now?.nickname, "Ada");
    assert.deepEqual(await listMemberRoles(local.server_user_id), ["admin"], "role kept");
  });

  it("carries ownership with it", async () => {
    // The case with nobody left to fix it by hand, and the reason this exists.
    await upsertUser("key:owner", "Owner");
    await claimServerOwner("key:owner");
    assert.equal((await getServerConfig())?.owner_gryt_user_id, "key:owner");

    assert.deepEqual(await carryIdentityForward("key:owner", "account-owner"), {
      status: "carried",
    });

    assert.equal(
      (await getServerConfig())?.owner_gryt_user_id,
      "account-owner",
      "still owns the server",
    );
  });

  it("says there was no prior membership when the old identity never joined", async () => {
    assert.deepEqual(await carryIdentityForward("key:never", "account-2"), {
      status: "no_prior_membership",
    });
  });

  it("refuses to merge when the account is already a member", async () => {
    // Two rows would have to become one, and there is no right way to
    // reconcile two sets of roles and two histories. Both are left alone.
    const local = await upsertUser("key:bbb", "Local");
    const account = await upsertUser("account-3", "Account");

    assert.deepEqual(await carryIdentityForward("key:bbb", "account-3"), {
      status: "account_already_member",
    });

    assert.equal((await getUserByGrytId("key:bbb"))?.server_user_id, local.server_user_id);
    assert.equal((await getUserByGrytId("account-3"))?.server_user_id, account.server_user_id);
  });

  it("tells the two refusals apart", async () => {
    // The whole point of the typed result. Both used to be `false`, so a
    // caller could not say "there was nothing to carry" rather than "you have
    // two memberships here and one of them stayed behind".
    await upsertUser("key:ccc", "Local");
    await upsertUser("account-4", "Account");

    const collision = await carryIdentityForward("key:ccc", "account-4");
    const nothing = await carryIdentityForward("key:absent", "account-5");

    assert.notEqual(collision.status, nothing.status);
  });
});
