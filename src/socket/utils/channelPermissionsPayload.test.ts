import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { CHANNEL_PERMISSIONS, type Permission } from "../../constants/permissions";
import { upsertServerChannel, upsertServerSidebarItem } from "../../db/sqlite/channels";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { sendServerDetails } from "./server";

/** Each channel in `server:details` names the channel permissions this member
    holds there, so a client can leave out what the server refuses (GRYT-1416). */

const HOST = "channel-permissions-payload.test:5001";
const MEMBER_ROLE = "cpp-member";
const QUIET_ROLE = "cpp-quiet";

const memberHolds: Permission[] = [
  "read_messages", "send_messages", "view_members", "attach_files", "add_reactions",
  "edit_own_messages", "delete_own_messages", "report_messages", "use_link_previews",
  "join_voice", "speak", "share_video", "share_screen",
];

let dir: string;
let memberId = "";
let quietId = "";

type SentChannel = { id: string; canSend?: boolean; canJoin?: boolean; myPermissions?: string[] };

async function channelsFor(grytUserId: string, serverUserId: string): Promise<Map<string, SentChannel>> {
  const emitted: { event: string; payload?: unknown }[] = [];
  const clientId = `sock-${grytUserId}`;
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
      return { emit() {} };
    },
  };
  const clientsInfo: Clients = {
    [clientId]: { serverUserId, grytUserId, nickname: grytUserId } as Clients[string],
  };
  await sendServerDetails(socket as never, clientsInfo, "cpp-test");
  const details = emitted.find((e) => e.event === "server:details")?.payload as
    | { channels?: SentChannel[]; error?: string }
    | undefined;
  assert.ok(details && !details.error, "no server:details went out");
  return new Map((details.channels ?? []).map((c) => [c.id, c]));
}

async function scoped(channelId: string, type: "text" | "voice", rules: { roleId: string; permission: string; effect: string }[]) {
  await upsertServerChannel({ channelId, name: channelId, type });
  const scopeId = await createPermissionScope({ scopeId: `scope-${channelId}` });
  await replacePermissionRules(scopeId, rules);
  await setChannelPermissionScope(channelId, scopeId);
  return scopeId;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-cpp-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await createRoleDefinition(MEMBER_ROLE, { name: "Member", rank: 10, permissions: memberHolds });
  await createRoleDefinition(QUIET_ROLE, { name: "Quiet", rank: 5, permissions: ["read_messages", "view_members"] });
  const member = await upsertUser("account-cpp-member", "Member");
  await setServerRole(member.server_user_id, MEMBER_ROLE);
  memberId = member.server_user_id;
  const quiet = await upsertUser("account-cpp-quiet", "Quiet");
  await setServerRole(quiet.server_user_id, QUIET_ROLE);
  quietId = quiet.server_user_id;

  // A sidebar naming no channel sends every visible one, and seeds nothing.
  await upsertServerSidebarItem({ itemId: "cpp-sep", kind: "separator", label: "Channels" });
  await upsertServerChannel({ channelId: "cpp-open", name: "open", type: "text" });
  await scoped("cpp-no-react", "text", [
    { roleId: MEMBER_ROLE, permission: "add_reactions", effect: "deny" },
    { roleId: MEMBER_ROLE, permission: "attach_files", effect: "deny" },
  ]);
  await scoped("cpp-stage", "voice", [
    { roleId: MEMBER_ROLE, permission: "share_screen", effect: "deny" },
    { roleId: QUIET_ROLE, permission: "join_voice", effect: "allow" },
  ]);
  await scoped("cpp-podium", "text", [{ roleId: QUIET_ROLE, permission: "send_messages", effect: "allow" }]);
  resetChannelPermissionCache();
});

after(() => {
  delete process.env.DATA_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file open past the run.
  }
});

describe("the channel payload", () => {
  it("names what a deny took, in that channel only", async () => {
    const channels = await channelsFor("account-cpp-member", memberId);
    const noReact = channels.get("cpp-no-react")?.myPermissions ?? [];
    assert.ok(!noReact.includes("add_reactions"));
    assert.ok(!noReact.includes("attach_files"));
    assert.ok(noReact.includes("send_messages"));
    const inMatrix = memberHolds.filter((p) => (CHANNEL_PERMISSIONS as readonly string[]).includes(p));
    assert.deepEqual([...(channels.get("cpp-open")?.myPermissions ?? [])].sort(), inMatrix.sort());
    assert.ok(!channels.get("cpp-stage")?.myPermissions?.includes("share_screen"));
    assert.ok(channels.get("cpp-stage")?.myPermissions?.includes("share_video"));
  });

  it("names what an allow gave, for a role without it elsewhere", async () => {
    const channels = await channelsFor("account-cpp-quiet", quietId);
    assert.ok(channels.get("cpp-podium")?.myPermissions?.includes("send_messages"));
    assert.ok(!channels.get("cpp-open")?.myPermissions?.includes("send_messages"));
    assert.ok(channels.get("cpp-stage")?.myPermissions?.includes("join_voice"));
  });

  it("agrees with canSend and canJoin on every channel", async () => {
    for (const [gryt, id] of [["account-cpp-member", memberId], ["account-cpp-quiet", quietId]]) {
      for (const c of (await channelsFor(gryt, id)).values()) {
        assert.equal(c.canSend, c.myPermissions?.includes("send_messages"), `${gryt} ${c.id} send`);
        assert.equal(c.canJoin, c.myPermissions?.includes("join_voice"), `${gryt} ${c.id} join`);
      }
    }
  });

  it("names nothing outside the matrix", async () => {
    const known = new Set<string>(CHANNEL_PERMISSIONS);
    for (const c of (await channelsFor("account-cpp-member", memberId)).values()) {
      for (const p of c.myPermissions ?? []) assert.ok(known.has(p), p);
    }
  });

  it("follows a rule change on the next send", async () => {
    // What every scope write does before it re-sends details to everybody.
    await replacePermissionRules("scope-cpp-no-react", [
      { roleId: MEMBER_ROLE, permission: "attach_files", effect: "deny" },
    ]);
    resetChannelPermissionCache();
    const channels = await channelsFor("account-cpp-member", memberId);
    assert.ok(channels.get("cpp-no-react")?.myPermissions?.includes("add_reactions"));
    assert.ok(!channels.get("cpp-no-react")?.myPermissions?.includes("attach_files"));
  });
});
