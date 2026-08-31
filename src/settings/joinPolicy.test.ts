import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeJoinPolicy } from "../db/sqlite/servers";
import { isJoinPolicy, JOIN_POLICIES } from "../db/interfaces";

/**
 * The two halves of a join policy: reading one out of a column, and accepting
 * one on the way in.
 *
 * They used to carry a list each. The reader knew three values and the settings
 * patch knew two, so `join_policy: "request"` was implemented all the way
 * through the server — schema column, join path, rate limit, permission, admin
 * queue, a Requests tab in the client — and could not be selected from
 * anywhere. The patch did not refuse it either; it returned `undefined`, which
 * means "leave this alone", so the caller was told the save had worked and the
 * value silently stayed `invite` (GRYT-792).
 *
 * These tests are about the two halves agreeing. Adding a fourth policy to
 * JOIN_POLICIES and forgetting one of them fails here rather than in
 * production.
 */
describe("join policy, in and out", () => {
  it("has the three the rest of the server implements", () => {
    assert.deepEqual([...JOIN_POLICIES].sort(), ["invite", "open", "request"]);
  });

  it("accepts every policy on the way in", () => {
    // The regression. "request" is the one that was dropped.
    for (const policy of JOIN_POLICIES) {
      assert.equal(isJoinPolicy(policy), true, `${policy} must be settable`);
    }
  });

  it("round-trips every policy back out of a column", () => {
    for (const policy of JOIN_POLICIES) {
      assert.equal(normalizeJoinPolicy(policy), policy);
    }
  });

  it("refuses anything else on the way in, rather than defaulting", () => {
    // Not the normaliser's job here. Reading a column fails shut to `invite`,
    // which is right for a value already stored. On a patch it would turn a
    // typo into a real policy change nobody asked for, so this says no and the
    // caller leaves the setting alone.
    for (const junk of [undefined, null, "", "  ", "Request", "INVITE", "public", "anyone", 1, {}, []]) {
      assert.equal(isJoinPolicy(junk), false, `${JSON.stringify(junk)} must not be settable`);
    }
  });

  it("still fails shut when reading a column", () => {
    for (const junk of [undefined, null, "", "public", "anyone", 1]) {
      assert.equal(normalizeJoinPolicy(junk), "invite");
    }
  });

  it("reads a stored column case-insensitively but will not accept one", () => {
    // The asymmetry is deliberate and worth pinning: a row hand-edited to
    // "REQUEST" should still be honoured, while a client sending "REQUEST"
    // should be told nothing changed rather than quietly succeeding.
    assert.equal(normalizeJoinPolicy("REQUEST"), "request");
    assert.equal(isJoinPolicy("REQUEST"), false);
  });
});
