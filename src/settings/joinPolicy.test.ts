import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeJoinPolicy } from "../db/sqlite/servers";
import { isJoinPolicy, JOIN_POLICIES } from "../db/interfaces";

/**
 * Reading a policy out of a column and accepting one on the way in used to carry
 * a list each, so `request` was implemented everywhere and selectable nowhere.
 * A fourth policy that reaches only one half fails here.
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
    // Reading a column fails shut to `invite`, which on a patch would turn a
    // typo into a policy change nobody asked for.
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
    // Deliberately asymmetric: a row hand-edited to "REQUEST" is honoured, and a
    // client sending it is told nothing changed.
    assert.equal(normalizeJoinPolicy("REQUEST"), "request");
    assert.equal(isJoinPolicy("REQUEST"), false);
  });
});
