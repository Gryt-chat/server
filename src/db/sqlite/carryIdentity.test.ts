import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { blockUser, eitherHasBlocked, listBlocks } from "./blocks";
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

/**
 * Blocks are keyed on the gryt id on both sides, and the move only rewrites the
 * one on `users`. Same four cases the merge path is tested for.
 */
describe("blocks follow a membership that moves to an account", () => {
  it("carries both directions and leaves nothing on the old id", async () => {
    await upsertUser("key:blocks-1", "Guest");
    await blockUser("account-pest-1", "key:blocks-1");
    await blockUser("key:blocks-1", "account-nuisance-1");

    assert.deepEqual(await carryIdentityForward("key:blocks-1", "account-blocks-1"), {
      status: "carried",
    });

    assert.equal(
      await eitherHasBlocked("account-pest-1", "account-blocks-1"),
      true,
      "the block somebody put on the guest stopped applying",
    );
    assert.deepEqual(
      (await listBlocks("account-blocks-1")).map((b) => b.grytUserId),
      ["account-nuisance-1"],
      "the block the guest made stopped applying",
    );
    assert.deepEqual(await listBlocks("key:blocks-1"), [], "left behind on the old id");
    assert.equal(await eitherHasBlocked("account-pest-1", "key:blocks-1"), false);
  });

  it("does not leave the account blocking itself", async () => {
    await upsertUser("key:blocks-2", "Guest");
    await blockUser("key:blocks-2", "account-blocks-2");
    await blockUser("account-blocks-2", "key:blocks-2");

    assert.deepEqual(await carryIdentityForward("key:blocks-2", "account-blocks-2"), {
      status: "carried",
    });

    assert.deepEqual(await listBlocks("account-blocks-2"), [], "a block on yourself");
    assert.equal(await eitherHasBlocked("account-blocks-2", "account-blocks-2"), false);
  });

  it("keeps one row when both ids had blocked the same person", async () => {
    await upsertUser("key:blocks-3", "Guest");
    await blockUser("key:blocks-3", "account-pest-3");
    await blockUser("account-blocks-3", "account-pest-3");
    await blockUser("account-pest-3", "key:blocks-3");
    await blockUser("account-pest-3", "account-blocks-3");

    assert.deepEqual(await carryIdentityForward("key:blocks-3", "account-blocks-3"), {
      status: "carried",
    });

    assert.deepEqual(
      (await listBlocks("account-blocks-3")).map((b) => b.grytUserId),
      ["account-pest-3"],
    );
    assert.deepEqual(
      (await listBlocks("account-pest-3")).map((b) => b.grytUserId),
      ["account-blocks-3"],
    );
  });
});
