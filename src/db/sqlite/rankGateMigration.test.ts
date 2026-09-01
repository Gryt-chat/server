import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rulesForRankGates } from "./rankGateMigration";

/**
 * The arithmetic that turns "rank 60 and above" into a set of rules.
 *
 * Tested on its own rather than through a database, because the translation is
 * the part that can be wrong and it reads as a table of cases when it is not
 * wrapped in schema. Whether the migration runs once, and inside a transaction,
 * is a different property and is checked in `channelPermissions.test.ts` where
 * a real database is already open.
 *
 * The failure mode worth guarding: an off-by-one at the boundary. A gate at 60
 * always admitted rank 60 — `auth.rank < postGate` was the comparison — so a
 * translation that denied at 60 would silently lock the moderators out of the
 * channel the gate was written to give them.
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
    // `auth.rank < postGate` was the old comparison, so 60 could post in a
    // channel gated at 60. Denying it here would lock out the very role the
    // gate was set to admit.
    const rules = rulesForRankGates(ROLES, 60, null);
    assert.ok(!denied(rules, "send_messages").includes("mod"));
  });

  it("denies reading below a view gate", () => {
    const rules = rulesForRankGates(ROLES, null, 80);
    assert.deepEqual(denied(rules, "read_messages"), ["guest", "member", "mod"]);
    assert.deepEqual(denied(rules, "send_messages"), []);
  });

  it("keeps the two gates apart when a channel had both", () => {
    // Independent before, independent after. Folding them together — dropping
    // the send denial because the role cannot read anyway — would mean a later
    // edit that restores reading silently restores posting with it.
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
    // A rank gate could never grant something the role lacked server-wide, so
    // the translation must not invent an allow — that would hand a role a
    // permission it did not have before the upgrade.
    const rules = rulesForRankGates(ROLES, 50, 50);
    assert.ok(rules.every((r) => r.effect === "deny"));
  });
});
