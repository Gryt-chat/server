import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rulesForRankGates } from "./rankGateMigration";

/**
 * The translation without a database. `auth.rank < postGate` admitted rank 60 at
 * a gate of 60, so denying it locks the moderators out.
 */

const ROLES = [
  { role_id: "guest", rank: 10 },
  { role_id: "member", rank: 40 },
  { role_id: "mod", rank: 60 },
  { role_id: "admin", rank: 80 },
  { role_id: "owner", rank: 100 },
];

function denied(rules: { roleId: string; permission: string }[], permission: string): string[] {
  return rules.filter((r) => r.permission === permission).map((r) => r.roleId).sort();
}

describe("translating a rank gate into rules", () => {
  it("writes nothing for a channel that had neither gate", () => {
    assert.deepEqual(rulesForRankGates(ROLES, null, null), []);
  });

  it("denies posting below the gate and leaves the gate itself alone", () => {
    const rules = rulesForRankGates(ROLES, 60, null);
    assert.deepEqual(denied(rules, "send_messages"), ["guest", "member"]);
    assert.deepEqual(denied(rules, "read_messages"), []);
  });

  it("admits the role standing exactly on the gate", () => {
    // `auth.rank < postGate` admitted 60 at a gate of 60, so denying it locks out
    // the role the gate was set to admit.
    const rules = rulesForRankGates(ROLES, 60, null);
    assert.ok(!denied(rules, "send_messages").includes("mod"));
  });

  it("denies reading below a view gate", () => {
    const rules = rulesForRankGates(ROLES, null, 80);
    assert.deepEqual(denied(rules, "read_messages"), ["guest", "member", "mod"]);
    assert.deepEqual(denied(rules, "send_messages"), []);
  });

  it("keeps the two gates apart when a channel had both", () => {
    // Independent before and after: folding them means a later edit restoring
    // reading silently restores posting.
    const rules = rulesForRankGates(ROLES, 80, 40);
    assert.deepEqual(denied(rules, "read_messages"), ["guest"]);
    assert.deepEqual(denied(rules, "send_messages"), ["guest", "member", "mod"]);
  });

  it("denies everybody below a gate above every rank", () => {
    const rules = rulesForRankGates(ROLES, null, 1000);
    assert.equal(denied(rules, "read_messages").length, ROLES.length);
  });

  it("denies nobody for a gate of zero", () => {
    // Rank 0 is a real gate rather than the absence of one, and no role is
    // below it, so it should translate to no rules at all.
    assert.deepEqual(rulesForRankGates(ROLES, 0, 0), []);
  });

  it("writes only deny rules", () => {
    // A rank gate never granted anything, so an invented allow hands a role a
    // permission it did not have before the upgrade.
    const rules = rulesForRankGates(ROLES, 50, 50);
    assert.ok(rules.every((r) => r.effect === "deny"));
  });
});
