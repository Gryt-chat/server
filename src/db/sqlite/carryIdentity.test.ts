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

  it("merges into the account when the account is already a member", async () => {
    const local = await upsertUser("key:bbb", "Local");
    const account = await upsertUser("account-3", "Account");

    const result = await carryIdentityForward("key:bbb", "account-3");

    assert.equal(result.status, "merged");
    assert.equal(await getUserByGrytId("key:bbb"), null, "the guest is gone");
    const now = await getUserByGrytId("account-3");
    assert.equal(now?.server_user_id, account.server_user_id, "the account keeps its own row");
    assert.equal(now?.nickname, "Account");
    if (result.status === "merged") {
      assert.equal(result.merge.guestServerUserId, local.server_user_id);
      assert.equal(result.merge.accountServerUserId, account.server_user_id);
    }
  });

  it("finds nothing to carry the second time", async () => {
    await upsertUser("key:ccc", "Local");
    await upsertUser("account-4", "Account");

    assert.equal((await carryIdentityForward("key:ccc", "account-4")).status, "merged");
    assert.deepEqual(await carryIdentityForward("key:ccc", "account-4"), {
      status: "no_prior_membership",
    });
    assert.equal((await getUserByGrytId("account-4"))?.nickname, "Account");
  });
});
