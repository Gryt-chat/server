import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import {
  createServerInvite,
  getServerInvite,
  listServerAudit,
} from "../db/sqlite/invites";
import {
  createRoleDefinition,
  getRoleDefinition,
  updateRoleDefinition,
} from "../db/sqlite/roleDefinitions";
import { listMemberRoles, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { applyInviteRole } from "./inviteRoles";

/**
 * The invite role binding against a real database.
 *
 * The rules have their own tests and are pure. What is only reachable here is
 * everything between them and SQLite: three columns added by migration, a
 * snapshot written at creation and read back at redemption, and an UPDATE whose
 * argument list has to line up with its placeholders. That last one was wrong
 * once already and would have written a role id into the flag column.
 */

let dir: string;
let seq = 0;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-inviterole-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function newMember() {
  seq += 1;
  const user = await upsertUser(`account-inv-${seq}`, `member${seq}`, {});
  await setServerRole(user.server_user_id, "member");
  return user.server_user_id;
}

describe("an invite that carries a role", () => {
  it("round-trips the role and its rank snapshot through SQLite", async () => {
    await createRoleDefinition("trusted", {
      name: "Trusted",
      color: null,
      rank: 20,
      permissions: ["send_messages"],
      grantableByInvite: true,
    });

    const invite = await createServerInvite("owner-1", {
      maxUses: 5,
      grantedRole: { roleId: "trusted", rank: 20 },
    });

    // Read back rather than trusting the return value: the columns are new and
    // a mapping that only works in memory is the failure being looked for.
    const stored = await getServerInvite(invite.code);
    assert.equal(stored?.granted_role_id, "trusted");
    assert.equal(stored?.granted_role_rank, 20);
  });

  it("grants the role on redemption, alongside what they already have", async () => {
    const invite = await createServerInvite("owner-1", {
      maxUses: 5,
      grantedRole: { roleId: "trusted", rank: 20 },
    });
    const member = await newMember();

    await applyInviteRole(invite.code, member);

    const roles = await listMemberRoles(member);
    assert.ok(roles.includes("trusted"), `expected trusted in ${roles.join()}`);
    // Added, not assigned. The tier default has to survive.
    assert.ok(roles.includes("member"), `expected member in ${roles.join()}`);
  });

  it("refuses after the role is edited upward, and says so in the audit log", async () => {
    const invite = await createServerInvite("owner-1", {
      maxUses: 5,
      grantedRole: { roleId: "trusted", rank: 20 },
    });

    // The exploit, run for real: bind low, then raise the role.
    await updateRoleDefinition("trusted", { rank: 90 });
    assert.equal((await getRoleDefinition("trusted"))?.rank, 90);

    const member = await newMember();
    await applyInviteRole(invite.code, member);

    const roles = await listMemberRoles(member);
    assert.ok(!roles.includes("trusted"), `trusted was granted: ${roles.join()}`);

    const audit = await listServerAudit(50);
    const refusal = audit.find(
      (a) => a.action === "invite_role_refused" && a.target === member,
    );
    assert.ok(refusal, "expected an invite_role_refused audit row");

    await updateRoleDefinition("trusted", { rank: 20 });
  });

  it("refuses once the flag is cleared, without touching the invite", async () => {
    const invite = await createServerInvite("owner-1", {
      maxUses: 5,
      grantedRole: { roleId: "trusted", rank: 20 },
    });
    await updateRoleDefinition("trusted", { grantableByInvite: false });

    const member = await newMember();
    await applyInviteRole(invite.code, member);

    assert.ok(!(await listMemberRoles(member)).includes("trusted"));
    // The invite itself is untouched: a refused role is not a refused invite.
    assert.equal((await getServerInvite(invite.code))?.granted_role_id, "trusted");

    await updateRoleDefinition("trusted", { grantableByInvite: true });
  });

  it("does nothing at all for an invite with no role bound", async () => {
    const invite = await createServerInvite("owner-1", { maxUses: 5 });
    assert.equal(invite.granted_role_id, null);

    const member = await newMember();
    await applyInviteRole(invite.code, member);

    assert.deepEqual(await listMemberRoles(member), ["member"]);
  });

  it("survives the role being deleted out from under it", async () => {
    await createRoleDefinition("temporary", {
      name: "Temporary",
      color: null,
      rank: 15,
      permissions: ["send_messages"],
      grantableByInvite: true,
    });
    const invite = await createServerInvite("owner-1", {
      maxUses: 5,
      grantedRole: { roleId: "temporary", rank: 15 },
    });

    const { deleteRoleDefinition } = await import("../db/sqlite/roleDefinitions");
    await deleteRoleDefinition("temporary", "member");

    const member = await newMember();
    await applyInviteRole(invite.code, member);

    assert.ok(!(await listMemberRoles(member)).includes("temporary"));
  });
});

describe("the flag itself", () => {
  it("defaults to off, so no existing role becomes grantable by adding the column", async () => {
    await createRoleDefinition("plain", {
      name: "Plain",
      color: null,
      rank: 12,
      permissions: ["send_messages"],
    });
    assert.equal((await getRoleDefinition("plain"))?.grantable_by_invite, false);
  });

  it("survives an unrelated edit, which is what the UPDATE arg list gets wrong", async () => {
    await createRoleDefinition("keeper", {
      name: "Keeper",
      color: null,
      rank: 14,
      permissions: ["send_messages"],
      grantableByInvite: true,
    });
    await updateRoleDefinition("keeper", { name: "Keeper Renamed" });

    const after = await getRoleDefinition("keeper");
    assert.equal(after?.name, "Keeper Renamed");
    assert.equal(after?.grantable_by_invite, true, "the flag was lost on an unrelated edit");
    assert.equal(after?.rank, 14, "rank was lost, so the arg list is misaligned");
  });
});
