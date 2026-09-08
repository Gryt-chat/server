import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backfillFor,
  BUILT_IN_ROLES,
  PERMISSION_BACKFILLS,
  PERMISSION_SCHEMA_VERSION,
  PERMISSIONS,
} from "./permissions";

/**
 * Nobody's ability changes across an upgrade, in either direction. The yardstick
 * is what a fresh server seeds: backfilling last version's set must reach it.
 */

/** The permission sets as they stood at schema version 1 (GRYT-444). */
const V1 = {
  guest: [] as string[],
  member: [
    "send_messages",
    "attach_files",
    "add_reactions",
    "join_voice",
    "speak",
    "share_video",
    "share_screen",
    "change_nickname",
    "change_avatar",
  ],
  mod: [
    "send_messages",
    "attach_files",
    "add_reactions",
    "join_voice",
    "speak",
    "share_video",
    "share_screen",
    "change_nickname",
    "change_avatar",
    "kick_members",
    "mute_members",
  ],
};

function seeded(roleId: string): string[] {
  const role = BUILT_IN_ROLES.find((r) => r.id === roleId);
  assert.ok(role, `no built-in ${roleId}`);
  return [...role.permissions];
}

function upgraded(from: string[]): string[] {
  return [...from, ...backfillFor(from, 1)];
}

describe("upgrading a role's permissions", () => {
  it("lands a v1 guest on exactly what a new server seeds", () => {
    assert.deepEqual(upgraded(V1.guest).sort(), seeded("guest").sort());
  });

  it("lands a v1 member on exactly what a new server seeds", () => {
    assert.deepEqual(upgraded(V1.member).sort(), seeded("member").sort());
  });

  it("lands a v1 moderator on exactly what a new server seeds", () => {
    assert.deepEqual(upgraded(V1.mod).sort(), seeded("mod").sort());
  });

  it("lands a v1 admin on exactly what a new server seeds", () => {
    // v1 admin was everything that existed then, minus the two owner-only ones.
    const v1Admin = PERMISSIONS.filter(
      (p) =>
        !PERMISSION_BACKFILLS.some((b) => b.permission === p) &&
        p !== "manage_roles" &&
        p !== "manage_server",
    );
    assert.deepEqual(upgraded([...v1Admin]).sort(), seeded("admin").sort());
  });

  it("does not hand replace_identity to an admin", () => {
    // Carved out of manage_server, which an admin never had, so the upgrade must
    // not be how they gain it.
    const v1Admin = PERMISSIONS.filter(
      (p) =>
        !PERMISSION_BACKFILLS.some((b) => b.permission === p) &&
        p !== "manage_roles" &&
        p !== "manage_server",
    );
    assert.equal(upgraded([...v1Admin]).includes("replace_identity"), false);
  });
});

describe("what the backfill will and will not do", () => {
  it("only ever grants", () => {
    const before = V1.member;
    const after = upgraded(before);
    for (const held of before) {
      assert.equal(after.includes(held), true, `${held} was taken away`);
    }
  });

  it("is idempotent", () => {
    const once = upgraded(V1.member);
    assert.deepEqual(backfillFor(once, PERMISSION_SCHEMA_VERSION), []);
    // And running the old version's grants again over the result changes
    // nothing, which is what makes a re-run after a crash safe.
    assert.deepEqual(backfillFor(once, 1), []);
  });

  it("gives a role that was stripped bare only the ungated four", () => {
    // A role emptied on purpose. It could still read, see members, report and
    // unfurl, because none had a gate, and it should still do exactly those.
    assert.deepEqual(backfillFor([], 1).sort(), [
      "read_messages",
      "report_messages",
      "use_link_previews",
      "view_members",
    ]);
  });

  it("does not give a role that cannot post the ability to edit posts", () => {
    const gained = backfillFor(["read_messages"], 1);
    assert.equal(gained.includes("edit_own_messages"), false);
    assert.equal(gained.includes("delete_own_messages"), false);
  });

  it("names only permissions that exist", () => {
    for (const entry of PERMISSION_BACKFILLS) {
      assert.equal(
        PERMISSIONS.includes(entry.permission),
        true,
        `${entry.permission} is not in PERMISSIONS`,
      );
      if (entry.grantedWith !== "everyone") {
        assert.equal(
          PERMISSIONS.includes(entry.grantedWith),
          true,
          `${entry.permission} follows ${entry.grantedWith}, which is not in PERMISSIONS`,
        );
      }
    }
  });

  it("covers every permission added since version 1", () => {
    // Catches a permission added to the catalogue and not the backfill list,
    // which upgrades to one silently held by nobody.
    const v1 = new Set([
      ...V1.mod,
      "manage_messages",
      "ban_members",
      "manage_reports",
      "manage_join_requests",
      "create_invite",
      "manage_invites",
      "manage_channels",
      "manage_emojis",
      "manage_webhooks",
      "manage_roles",
      "manage_server",
      "view_audit_log",
    ]);
    const backfilled = new Set(PERMISSION_BACKFILLS.map((b) => b.permission));

    for (const permission of PERMISSIONS) {
      if (v1.has(permission)) continue;
      assert.equal(
        backfilled.has(permission),
        true,
        `${permission} is new since v1 and has no backfill entry`,
      );
    }
  });

  /** The sweep above only asks whether an entry exists. Uploading a picture was
      part of `change_avatar`, so everybody who could already do it keeps it. */
  it("hands picture uploads to whoever could already set an avatar", () => {
    const withAvatar = backfillFor(["change_avatar"], 5, 6);
    assert.deepEqual(withAvatar, ["upload_avatar_image"]);

    // And to nobody else. A guest that could not set an avatar does not
    // acquire the ability to upload one by upgrading.
    const withoutAvatar = backfillFor(["read_messages", "view_members"], 5, 6);
    assert.deepEqual(withoutAvatar, []);
  });
});
