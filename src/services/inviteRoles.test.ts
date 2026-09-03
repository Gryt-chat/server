import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mayBindRoleToInvite,
  mayRedeemInviteRole,
  type RoleFacts,
} from "./inviteRoles";

const role = (over: Partial<RoleFacts> = {}): RoleFacts => ({
  roleId: "trusted",
  rank: 20,
  permissions: ["send_messages", "attach_files"],
  grantableByInvite: true,
  ...over,
});

// ── Binding, with the actor present ──────────────────────────────────────

test("a flagged role below the actor can be bound", () => {
  assert.equal(mayBindRoleToInvite(role(), 80).ok, true);
});

test("a role has to be flagged, so nothing is grantable by default", () => {
  const v = mayBindRoleToInvite(role({ grantableByInvite: false }), 80);
  assert.deepEqual(v, { ok: false, reason: "not_grantable" });
});

test("the owner role is never bindable", () => {
  const v = mayBindRoleToInvite(role({ roleId: "owner", rank: 100 }), 100);
  assert.deepEqual(v, { ok: false, reason: "owner_role" });
});

test("admin is never bindable, even flagged and even below the actor", () => {
  // The one the request asked for by name: admin is given by hand.
  const v = mayBindRoleToInvite(role({ roleId: "admin", rank: 80 }), 100);
  assert.deepEqual(v, { ok: false, reason: "admin_role" });
});

test("a role carrying a grant-shaped permission is never bindable", () => {
  const v = mayBindRoleToInvite(
    role({ permissions: ["send_messages", "manage_roles"] }),
    80,
  );
  assert.deepEqual(v, { ok: false, reason: "escalation_permission" });
});

test("binding a role at or above your own rank is refused", () => {
  assert.deepEqual(mayBindRoleToInvite(role({ rank: 80 }), 80), {
    ok: false,
    reason: "rank_not_below_actor",
  });
  assert.deepEqual(mayBindRoleToInvite(role({ rank: 81 }), 80), {
    ok: false,
    reason: "rank_not_below_actor",
  });
});

// ── Redeeming, with nobody present ───────────────────────────────────────

test("an unchanged role still redeems", () => {
  assert.equal(mayRedeemInviteRole(role({ rank: 20 }), 20).ok, true);
});

test("THE EXPLOIT: raising the role's rank after binding refuses the grant", () => {
  // Bind `trusted` at rank 20, then edit it to rank 90. Without the snapshot
  // the link would hand out rank 90, and no check would ever have failed.
  const v = mayRedeemInviteRole(role({ rank: 90 }), 20);
  assert.deepEqual(v, { ok: false, reason: "rank_raised_since" });
});

test("a role demoted since binding still redeems, at the lower rank", () => {
  // Nobody needs protecting from getting less than was agreed.
  assert.equal(mayRedeemInviteRole(role({ rank: 5 }), 20).ok, true);
});

test("THE OTHER EXPLOIT: widening the role's permissions refuses the grant", () => {
  // Rank untouched, so the snapshot alone would not catch this.
  const v = mayRedeemInviteRole(
    role({ rank: 20, permissions: ["send_messages", "manage_server"] }),
    20,
  );
  assert.deepEqual(v, { ok: false, reason: "escalation_permission" });
});

test("clearing the flag after binding refuses the grant", () => {
  const v = mayRedeemInviteRole(role({ grantableByInvite: false }), 20);
  assert.deepEqual(v, { ok: false, reason: "not_grantable" });
});

test("a deleted role refuses the grant rather than throwing", () => {
  assert.deepEqual(mayRedeemInviteRole(null, 20), {
    ok: false,
    reason: "unknown_role",
  });
});

test("a role renamed onto the admin id refuses the grant", () => {
  // Roles are addressed by id, so this is only reachable by deleting `admin`
  // and recreating it. Refused anyway: the id is what the rule names.
  const v = mayRedeemInviteRole(role({ roleId: "admin" }), 20);
  assert.deepEqual(v, { ok: false, reason: "admin_role" });
});

test("redeeming does not consult the creator, so a demoted creator's link still works", () => {
  // Deliberate. The snapshot and the rules bound what the link can do; the
  // creator may have left, and a link that dies when somebody leaves is a
  // different bug. Written down so the choice is visible rather than assumed.
  assert.equal(mayRedeemInviteRole(role(), 20).ok, true);
});
