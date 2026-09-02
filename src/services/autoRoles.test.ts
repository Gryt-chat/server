import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite, getSqliteDb } from "../db/sqlite/connection";
import { insertMessage } from "../db/sqlite/messages";
import {
  createRoleDefinition,
  getRoleDefinition,
  updateRoleDefinition,
} from "../db/sqlite/roleDefinitions";
import { listServerAudit } from "../db/sqlite/invites";
import {
  claimServerOwner,
  listMemberRoles,
  setServerRole,
} from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { applyAutoRoles } from "./autoRoles";

/**
 * Roles that hand themselves out.
 *
 * The failure that matters is a promotion that should not have happened —
 * somebody quiet crossing a time threshold, or a moderator being pushed
 * sideways into a lower tier — so most of this is about what does *not* get
 * granted.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-autorole-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

/** A member who joined `daysAgo` days ago and has posted `messages` messages. */
async function memberWithHistory(daysAgo: number, messages: number) {
  seq += 1;
  const grytUserId = `account-auto-${seq}`;
  const user = await upsertUser(grytUserId, `Auto ${seq}`);
  await setServerRole(user.server_user_id, "member");

  const joined = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  getSqliteDb()
    .prepare(`UPDATE users SET created_at = ? WHERE server_user_id = ?`)
    .run(joined.toISOString(), user.server_user_id);

  for (let i = 0; i < messages; i += 1) {
    await insertMessage({
      conversation_id: "general",
      message_id: `auto-${seq}-${i}`,
      sender_server_id: user.server_user_id,
      text: "hello",
      attachments: null,
      reactions: null,
      created_at: new Date(),
    });
  }

  return { ...user, grytUserId };
}

describe("a role that grants itself", () => {
  before(async () => {
    await createRoleDefinition("regular", {
      name: "Regular",
      rank: 45,
      permissions: ["attach_files"],
      autoGrantAfterDays: 14,
      autoGrantAfterMessages: 50,
    });
  });

  it("grants once both conditions are met", async () => {
    const user = await memberWithHistory(20, 60);
    const result = await applyAutoRoles(user.server_user_id, user.grytUserId);

    assert.equal(result?.granted.role_id, "regular");
    assert.deepEqual(await listMemberRoles(user.server_user_id), ["regular"]);
  });

  it("wants both, not either", async () => {
    // The one that matters. Time alone would hand the tier to an account that
    // signed up a month ago and has never spoken.
    const patient = await memberWithHistory(400, 3);
    assert.equal(await applyAutoRoles(patient.server_user_id, patient.grytUserId), null);
    assert.deepEqual(await listMemberRoles(patient.server_user_id), ["member"]);

    const chatty = await memberWithHistory(1, 500);
    assert.equal(await applyAutoRoles(chatty.server_user_id, chatty.grytUserId), null);
    assert.deepEqual(await listMemberRoles(chatty.server_user_id), ["member"]);
  });

  it("does nothing twice", async () => {
    const user = await memberWithHistory(20, 60);
    assert.ok(await applyAutoRoles(user.server_user_id, user.grytUserId));
    assert.equal(await applyAutoRoles(user.server_user_id, user.grytUserId), null);
  });

  it("never moves somebody down", async () => {
    // A moderator who does not post much must not be pulled sideways into a
    // tier below the one they were given by hand.
    const mod = await memberWithHistory(400, 500);
    await setServerRole(mod.server_user_id, "mod");

    assert.equal(await applyAutoRoles(mod.server_user_id, mod.grytUserId), null);
    assert.deepEqual(await listMemberRoles(mod.server_user_id), ["mod"]);
  });

  it("leaves the owner alone", async () => {
    const owner = await memberWithHistory(400, 500);
    await claimServerOwner(owner.grytUserId);
    // Deliberately a low roles row, the way a config-owner can look.
    await setServerRole(owner.server_user_id, "guest");

    assert.equal(await applyAutoRoles(owner.server_user_id, owner.grytUserId), null);
    assert.deepEqual(await listMemberRoles(owner.server_user_id), ["guest"]);
  });

  it("records who did it, which is nobody", async () => {
    const user = await memberWithHistory(20, 60);
    await applyAutoRoles(user.server_user_id, user.grytUserId);

    const entries = await listServerAudit(50);
    const entry = entries.find(
      (e: { action: string; target: string | null }) =>
        e.action === "role_auto_granted" && e.target === user.server_user_id,
    );
    assert.ok(entry, "an entry was written");
    assert.equal(entry.actor_server_user_id, null, "no actor — nobody performed it");

    const meta = JSON.parse(entry.meta_json ?? "{}");
    assert.equal(meta.role, "regular");
    assert.equal(meta.from, "member");
    // What it asked for and what it found, so the log answers "why" on its own.
    assert.equal(meta.afterDays, 14);
    assert.equal(meta.afterMessages, 50);
  });

  it("takes the highest tier earned, not the next one up", async () => {
    await createRoleDefinition("veteran", {
      name: "Veteran",
      rank: 48,
      permissions: ["attach_files"],
      autoGrantAfterDays: 30,
      autoGrantAfterMessages: 100,
    });

    const user = await memberWithHistory(90, 300);
    const result = await applyAutoRoles(user.server_user_id, user.grytUserId);
    assert.equal(result?.granted.role_id, "veteran");
  });
});

describe("a server that has configured none of this", () => {
  it("grants nothing", async () => {
    // Every role's thresholds cleared, which is how every server starts.
    for (const id of ["regular", "veteran"]) {
      await updateRoleDefinition(id, {
        autoGrantAfterDays: null,
        autoGrantAfterMessages: null,
      });
    }

    const user = await memberWithHistory(999, 999);
    assert.equal(await applyAutoRoles(user.server_user_id, user.grytUserId), null);
    assert.deepEqual(await listMemberRoles(user.server_user_id), ["member"]);
  });

  it("reads a zero threshold as off, not as immediately", async () => {
    // A stray 0 would otherwise be a promotion nobody configured, on arrival.
    await updateRoleDefinition("regular", {
      autoGrantAfterDays: 0,
      autoGrantAfterMessages: 0,
    });
    const regular = await getRoleDefinition("regular");
    assert.equal(regular?.auto_grant_after_days, null);
    assert.equal(regular?.auto_grant_after_messages, null);

    const user = await memberWithHistory(0, 0);
    assert.equal(await applyAutoRoles(user.server_user_id, user.grytUserId), null);
  });
});
