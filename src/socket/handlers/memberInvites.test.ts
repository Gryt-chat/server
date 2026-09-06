import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerInvite, revokeServerInvite } from "../../db/sqlite/invites";
import {
  createRoleDefinition,
} from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { generateAccessToken } from "../../utils/jwt";
import type { Clients } from "../../types";
import { registerAdminHandlers } from "./admin";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * How every member got in, in one answer (GRYT-923).
 *
 * The gate is covered by permissionGates.test.ts. What is here is the payload,
 * because the useful failures are all about members the simple version would
 * quietly drop: somebody who arrived before invites existed, somebody whose
 * invite has since been deleted, and somebody who left.
 */

const HOST = "member-invites.test:5001";

let dir: string;
let token: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-member-invites-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await createRoleDefinition("inviter", {
    name: "Inviter",
    rank: 50,
    permissions: ["manage_invites"],
  });
  const admin = await upsertUser("account-admin", "Admin");
  await setServerRole(admin.server_user_id, "inviter");
  token = generateAccessToken({
    grytUserId: "account-admin",
    serverUserId: admin.server_user_id,
    nickname: "Admin",
    serverHost: HOST,
    tokenVersion: 0,
  });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

interface Emitted {
  event: string;
  payload: unknown;
}

function makeContext(): { ctx: HandlerContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const socket = {
    id: "socket-under-test",
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
  };
  const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } };
  const ctx = {
    io,
    socket,
    clientId: "socket-under-test",
    serverId: "member-invites-test",
    clientsInfo: {} as Clients,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return { ctx, emitted };
}

function handlers(ctx: HandlerContext): EventHandlerMap {
  return registerAdminHandlers(ctx);
}

interface Row {
  serverUserId: string;
  code: string;
  note: string | null;
  revoked: boolean | null;
  usesConsumed: number | null;
  maxUses: number | null;
}

async function fetchRows(): Promise<Row[]> {
  const { ctx, emitted } = makeContext();
  await handlers(ctx)["server:members:invites"]({ accessToken: token });
  const answer = emitted.find((e) => e.event === "server:members:invites");
  assert.ok(answer, `no answer; got ${emitted.map((e) => e.event).join(", ")}`);
  return (answer.payload as { members: Row[] }).members;
}

describe("who came in on what", () => {
  it("names the invite, its note and whether it still works", async () => {
    const invite = await createServerInvite(null, { maxUses: 5, note: "Kari's friends" });
    const member = await upsertUser("account-kari", "Kari", { inviteCode: invite.code });

    const row = (await fetchRows()).find((r) => r.serverUserId === member.server_user_id);
    assert.ok(row, "the member who used an invite was not in the answer");
    assert.equal(row.code, invite.code);
    assert.equal(row.note, "Kari's friends");
    assert.equal(row.revoked, false);
    assert.equal(row.maxUses, 5);
  });

  /* The whole point of showing this: you find the bad invite, you revoke it,
     and the row has to say so afterwards rather than still reading as live. */
  it("says when the invite has since been revoked", async () => {
    const invite = await createServerInvite(null, { maxUses: 1, note: "oops" });
    const member = await upsertUser("account-tor", "Tor", { inviteCode: invite.code });
    await revokeServerInvite(invite.code);

    const row = (await fetchRows()).find((r) => r.serverUserId === member.server_user_id);
    assert.equal(row?.revoked, true);
  });

  /*
   * Somebody who arrived without one is not a row.
   *
   * The first member claims the server, and a LAN or open join needs no code,
   * so this is ordinary rather than an edge case. A row with an empty code
   * would read as "we lost their invite" instead of "there wasn't one".
   */
  it("leaves out anybody who arrived without an invite", async () => {
    const member = await upsertUser("account-owner", "Owner");
    const rows = await fetchRows();
    assert.equal(rows.some((r) => r.serverUserId === member.server_user_id), false);
  });

  /*
   * An invite that no longer exists still names itself.
   *
   * They did come in on that code, and dropping the row would imply they
   * arrived some other way. The nulls say the invite is gone rather than that
   * it is fine.
   */
  it("keeps the code when the invite itself is gone", async () => {
    const member = await upsertUser("account-ada", "Ada", { inviteCode: "deleted-code" });

    const row = (await fetchRows()).find((r) => r.serverUserId === member.server_user_id);
    assert.ok(row, "a member whose invite was deleted should still be listed");
    assert.equal(row.code, "deleted-code");
    assert.equal(row.revoked, null);
    assert.equal(row.note, null);
    assert.equal(row.usesConsumed, null);
  });

  it("answers in one emit rather than one per member", async () => {
    const { ctx, emitted } = makeContext();
    await handlers(ctx)["server:members:invites"]({ accessToken: token });
    assert.equal(
      emitted.filter((e) => e.event === "server:members:invites").length,
      1,
      "the list must cost one round trip whatever the member count",
    );
  });
});
