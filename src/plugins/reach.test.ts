import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROTECTED_PERMISSIONS, pluginMayActOn } from "./reach";
import type { Permission } from "../constants/permissions";
import type { EffectiveStanding } from "../services/permissions";

/**
 * A plugin holds no role, so there is no rank to compare and this takes that
 * check's place: a plugin cannot act on a moderator.
 */

const standing = (over: Partial<EffectiveStanding> = {}): EffectiveStanding => ({
  roleId: "member",
  roleIds: ["member"],
  rank: 10,
  permissions: new Set<Permission>(["send_messages"]),
  isOwner: false,
  ...over,
});

describe("an ordinary member", () => {
  it("is reachable", () => {
    assert.deepEqual(pluginMayActOn(standing()), { allowed: true });
  });

  /* Rank is the operator's to arrange. A rule written against the number would
     mean renumbering roles quietly changed who a plugin could ban. */
  it("is reachable however high their rank is, if they hold nothing", () => {
    assert.deepEqual(
      pluginMayActOn(standing({ rank: Number.MAX_SAFE_INTEGER })),
      { allowed: true },
    );
  });

  it("is reachable holding a pile of harmless permissions", () => {
    assert.deepEqual(
      pluginMayActOn(
        standing({
          permissions: new Set<Permission>([
            "send_messages",
            "attach_files",
            "create_invite",
            "change_nickname",
            "join_voice",
          ]),
        }),
      ),
      { allowed: true },
    );
  });
});

describe("the owner", () => {
  it("is out of reach", () => {
    const result = pluginMayActOn(standing({ isOwner: true }));
    assert.equal(result.allowed, false);
    assert.match(result.allowed === false ? result.reason : "", /owns this server/);
  });

  /* Checked before the permission loop, so an owner whose role row is missing
     — the one case computeStanding fails open on — is still out of reach. */
  it("is out of reach holding no permissions at all", () => {
    assert.equal(
      pluginMayActOn(standing({ isOwner: true, permissions: new Set() })).allowed,
      false,
    );
  });
});

describe("a moderator", () => {
  for (const permission of PROTECTED_PERMISSIONS) {
    it(`is out of reach holding ${permission}`, () => {
      const result = pluginMayActOn(
        standing({ permissions: new Set<Permission>(["send_messages", permission]) }),
      );
      assert.equal(result.allowed, false);
      assert.match(
        result.allowed === false ? result.reason : "",
        new RegExp(permission),
        "the refusal should name the permission, so an operator can see why",
      );
    });
  }

  /* Written against the list rather than one example, so it keeps meaning
     something when a permission is added to it. */
  it("covers every permission that can remove or silence somebody", () => {
    for (const permission of ["kick_members", "ban_members", "mute_members"] as const) {
      assert.ok(
        PROTECTED_PERMISSIONS.includes(permission),
        `${permission} can take a member out and is not protected`,
      );
    }
  });

  /* One step removed: somebody who can edit roles can give themselves
     ban_members, so they were always able to become unreachable. */
  it("is out of reach holding only manage_roles", () => {
    assert.equal(
      pluginMayActOn(standing({ permissions: new Set<Permission>(["manage_roles"]) })).allowed,
      false,
    );
  });
});

/* An unreadable member comes back at rank 0 and so is reachable, which is the
   right way round: no evidence of being a moderator is not being one. */
describe("a standing that could not be resolved", () => {
  it("is reachable, and that is deliberate", () => {
    assert.deepEqual(
      pluginMayActOn(standing({ roleId: "", roleIds: [], rank: 0, permissions: new Set() })),
      { allowed: true },
    );
  });
});
