import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { createPermissionScope } from "../../db/sqlite/channelScopes";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerAdminChannelHandlers } from "./adminChannels";
import type { HandlerContext } from "./types";

/**
 * What a channel can be pointed at, asked by somebody who may point it.
 *
 * Two permissions meet here and they are deliberately different: arranging one
 * channel is `manage_channels`, and deciding what a template says is
 * `manage_roles`. The bug was that the names lived behind the second one, so
 * the first was a permission you held and could not use — and it is invisible
 * on a server where one person holds both, which is every server until it has
 * moderators.
 */
const HOST = "scopes.test";
const CHANNEL = "arena";

let dir: string;
let editor: { serverUserId: string; grytUserId: string; accessToken: string };
let policyMaker: { serverUserId: string; grytUserId: string; accessToken: string };

async function memberWith(name: string, permissions: Permission[]) {
  const roleId = `scoped-${name}`;
  const grytUserId = `account-${name}`;
  await createRoleDefinition(roleId, { name, rank: 50, permissions });
  const user = await upsertUser(grytUserId, name);
  await setServerRole(user.server_user_id, roleId);
  return {
    serverUserId: user.server_user_id,
    grytUserId,
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname: name,
      serverHost: HOST,
      tokenVersion: 0,
    }),
  };
}

/** Just enough socket for a handler whose whole output is one emit. */
function harness(member: { serverUserId: string; grytUserId: string }) {
  const emitted: { event: string; payload: unknown }[] = [];
  const clientId = `sock-${member.serverUserId}`;
  const clientsInfo: Clients = {
    [clientId]: {
      serverUserId: member.serverUserId,
      grytUserId: member.grytUserId,
      nickname: "tester",
    } as unknown as Clients[string],
  };

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    rooms: new Set<string>(["verifiedClients"]),
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    join() {},
    leave() {},
    to() {
      return { emit(event: string, payload?: unknown) { emitted.push({ event, payload }); } };
    },
  };

  const ctx = {
    io: { sockets: { sockets: new Map([[clientId, socket]]) }, to: () => ({ emit() {} }) },
    socket,
    clientId,
    serverId: "srv_test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { ctx, emitted };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-scopetemplates-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: CHANNEL, name: "Arena", type: "text" });
  await createPermissionScope({ name: "Staff only", isTemplate: true });
  await createPermissionScope({ name: "Read only", isTemplate: true });
  // A channel's private rules, which is not a template and must not be offered
  // as one — a dropdown of unnamed scopes nobody can tell apart.
  await createPermissionScope({ isTemplate: false });

  editor = await memberWith("editor", ["manage_channels"]);
  policyMaker = await memberWith("policy", ["manage_channels", "manage_roles"]);
  resetChannelPermissionCache();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("what a channel can be pointed at", () => {
  it("names the templates to somebody who may only arrange channels", async () => {
    const h = harness(editor);
    await registerAdminChannelHandlers(h.ctx)["server:channels:scope:get"]({
      accessToken: editor.accessToken,
      channelId: CHANNEL,
    });

    const scope = h.emitted.find((e) => e.event === "server:channels:scope");
    assert.ok(scope, `no scope reply:\n${JSON.stringify(h.emitted, null, 2)}`);

    const names = ((scope.payload as { templates?: { name: string | null }[] }).templates ?? [])
      .map((t) => t.name)
      .sort();
    assert.deepEqual(names, ["Read only", "Staff only"]);
  });

  it("leaves out a channel's private scope", async () => {
    // Only templates. An unnamed scope in the dropdown is a row that says
    // nothing and cannot be chosen meaningfully.
    const h = harness(editor);
    await registerAdminChannelHandlers(h.ctx)["server:channels:scope:get"]({
      accessToken: editor.accessToken,
      channelId: CHANNEL,
    });

    const scope = h.emitted.find((e) => e.event === "server:channels:scope");
    const templates = (scope!.payload as { templates?: { name: string | null }[] }).templates ?? [];
    assert.ok(templates.every((t) => t.name), "an unnamed scope was offered as a template");
  });

  it("says nothing about what the templates decide", async () => {
    // The names are enough to point a channel at one. What a template allows
    // is server-wide policy and stays behind manage_roles.
    const h = harness(editor);
    await registerAdminChannelHandlers(h.ctx)["server:channels:scope:get"]({
      accessToken: editor.accessToken,
      channelId: CHANNEL,
    });

    const scope = h.emitted.find((e) => e.event === "server:channels:scope");
    const templates = (scope!.payload as { templates?: Record<string, unknown>[] }).templates ?? [];
    assert.ok(templates.length > 0);
    assert.ok(templates.every((t) => !("rules" in t)), "the scope reply carried template rules");
  });

  it("still refuses the rules to somebody without manage_roles", async () => {
    const h = harness(editor);
    await registerAdminChannelHandlers(h.ctx)["server:permissions:templates:list"]({
      accessToken: editor.accessToken,
    });

    assert.ok(
      !h.emitted.some((e) => e.event === "server:permissions:templates"),
      "template rules reached somebody without manage_roles",
    );
  });

  it("gives the rules to somebody who has it", async () => {
    const h = harness(policyMaker);
    await registerAdminChannelHandlers(h.ctx)["server:permissions:templates:list"]({
      accessToken: policyMaker.accessToken,
    });

    assert.ok(h.emitted.some((e) => e.event === "server:permissions:templates"));
  });
});
