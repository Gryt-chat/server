import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { initSqlite } from "../../db/sqlite/connection";
import { listServerChannels, listServerSidebarItems, upsertServerChannel, upsertServerSidebarItem } from "../../db/sqlite/channels";
import { listPermissionRules } from "../../db/sqlite/channelScopes";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { broadcastMemberList } from "../utils/clients";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { sendServerDetails } from "../utils/server";
import { registerAdminChannelHandlers } from "./adminChannels";
import { registerChatHandlers } from "./chat";
import type { HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * Every case runs the real handlers as the member it is about, and looks at what
 * that member's socket was sent. A folder's name counts as leaked anywhere in it.
 */

const HOST = "folders-perms.test:5001";
const SERVER_ID = "folder-perms-test";

const FOLDER = "sb-fold-staff";
const FOLDER_NAME = "Quartermaster";
const STAFF_TEXT = "fp-staff-chat";
const STAFF_VOICE = "fp-staff-room";
const OWN = "fp-announcements";
const OPEN_TEXT = "fp-open";
const OPEN_VOICE = "fp-lounge";
const LOOSE = "fp-loose";

const MEMBER_ROLE = "fp-member";

let dir: string;

async function memberWith(name: string, rank: number, permissions: Permission[]) {
  const roleId = `fp-${name}`;
  const grytUserId = `account-fp-${name}`;
  await createRoleDefinition(roleId, { name, rank, permissions });
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

type Member = Awaited<ReturnType<typeof memberWith>>;

let member: Member;
let admin: Member;
let arranger: Member;

interface Emitted {
  to: string | null;
  event: string;
  payload: unknown;
}

/** A granted room is what the positive cases look for, so the SFU says yes. */
const fakeSfu = {
  isConnected: () => true,
  registerRoom: async () => {},
  generateClientJoinToken: (roomId: string, userId: string) => ({ room_id: roomId, user_token: "stub", user_id: userId }),
  getActiveUsers: () => new Map(),
  untrackUserConnection: () => {},
};

/** Both members' sockets in one map, since the broadcasts pick their audience
    out of it. `voice` seats somebody in a room. */
function harness(self: Member, others: Member[] = [], voice: Record<string, string> = {}) {
  const emitted: Emitted[] = [];
  const clientsInfo: Clients = {};
  const sockets = new Map<string, ReturnType<typeof makeSocket>>();

  function makeSocket(id: string) {
    return {
      id,
      handshake: { headers: { host: HOST }, address: "127.0.0.1" },
      rooms: new Set<string>(["verifiedClients"]),
      emit(event: string, payload?: unknown) {
        emitted.push({ to: id, event, payload });
        return true;
      },
      join() {},
      leave() {},
      to() {
        return { emit(event: string, payload?: unknown) { emitted.push({ to: null, event, payload }); } };
      },
    };
  }

  for (const m of [self, ...others]) {
    const id = `sock-${m.serverUserId}`;
    sockets.set(id, makeSocket(id));
    clientsInfo[id] = {
      serverUserId: m.serverUserId,
      grytUserId: m.grytUserId,
      nickname: m.grytUserId,
      permissions: new Set<Permission>(["view_members"]),
      voiceChannelId: voice[m.serverUserId] ?? "",
      isConnectedToVoice: Boolean(voice[m.serverUserId]),
      hasJoinedChannel: Boolean(voice[m.serverUserId]),
    } as unknown as Clients[string];
  }

  const io = {
    to() {
      return { emit(event: string, payload?: unknown) { emitted.push({ to: null, event, payload }); } };
    },
    emit(event: string, payload?: unknown) { emitted.push({ to: null, event, payload }); },
    sockets: { sockets },
  };

  const clientId = `sock-${self.serverUserId}`;
  const ctx = {
    io,
    socket: sockets.get(clientId),
    clientId,
    serverId: SERVER_ID,
    clientsInfo,
    sfuClient: fakeSfu,
    getClientIp: () => `10.9.${self.serverUserId.length}.1`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  const to = (m: Member) => emitted.filter((e) => e.to === null || e.to === `sock-${m.serverUserId}`);
  return { ctx, emitted, clientsInfo, socket: sockets.get(clientId)!, to };
}

async function asAdmin(event: string, payload: Record<string, unknown>) {
  const h = harness(admin);
  await registerAdminChannelHandlers(h.ctx)[event]({ accessToken: admin.accessToken, ...payload });
  const refused = h.emitted.filter((e) => e.event === "server:error");
  assert.deepEqual(refused, [], `${event} refused the admin`);
  return h;
}

/** What `server:details` and `server:sidebar:list` hand this member, together. */
async function whatTheySee(who: Member): Promise<string> {
  const h = harness(who);
  await sendServerDetails(h.socket as never, h.clientsInfo, SERVER_ID);
  await registerAdminChannelHandlers(h.ctx)["server:sidebar:list"]({ accessToken: who.accessToken });
  return JSON.stringify(h.to(who));
}

async function fetchAs(who: Member, conversationId: string) {
  const h = harness(who);
  await registerChatHandlers(h.ctx)["chat:fetch"]({ conversationId });
  return h.to(who).map((e) => ({ event: e.event, payload: e.event === "chat:history" ? "history" : e.payload }));
}

async function sendAs(who: Member, conversationId: string) {
  const h = harness(who);
  await registerChatHandlers(h.ctx)["chat:send"]({ conversationId, accessToken: who.accessToken, text: "hello?" });
  return h.to(who).filter((e) => e.event === "chat:error").map((e) => e.payload);
}

async function joinAs(who: Member, roomId: string) {
  const h = harness(who);
  await registerVoiceHandlers(h.ctx)["voice:room:request"](roomId);
  return h.to(who).filter((e) => e.event.startsWith("voice:room:"));
}

async function scopeOf(channelId: string) {
  const h = await asAdmin("server:channels:scope:get", { channelId });
  return h.emitted.find((e) => e.event === "server:channels:scope")?.payload as {
    scopeId: string | null;
    isTemplate: boolean;
    rules: { roleId: string; permission: string; effect: string }[];
    followsFolder?: boolean;
    folder?: { id: string; name: string | null } | null;
  };
}

const denyReading = [{ roleId: MEMBER_ROLE, permission: "read_messages", effect: "deny" }];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-folder-perms-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  const basics: Permission[] = ["read_messages", "send_messages", "join_voice", "speak", "view_members"];
  member = await memberWith("member", 10, basics);
  admin = await memberWith("admin", 90, [...basics, "manage_channels", "manage_sidebar", "manage_roles"]);
  arranger = await memberWith("arranger", 50, [...basics, "manage_sidebar"]);

  await upsertServerChannel({ channelId: OPEN_TEXT, name: "Open", type: "text" });
  await upsertServerChannel({ channelId: OPEN_VOICE, name: "Lounge", type: "voice" });
  await upsertServerChannel({ channelId: STAFF_TEXT, name: "Staff chat", type: "text" });
  await upsertServerChannel({ channelId: STAFF_VOICE, name: "Staff room", type: "voice" });
  await upsertServerChannel({ channelId: OWN, name: "Announcements", type: "text" });
  await upsertServerChannel({ channelId: LOOSE, name: "Loose", type: "text" });

  await upsertServerSidebarItem({ itemId: "sb-open", kind: "channel", channelId: OPEN_TEXT, position: 10 });
  await upsertServerSidebarItem({ itemId: "sb-lounge", kind: "channel", channelId: OPEN_VOICE, position: 20 });
  await upsertServerSidebarItem({ itemId: FOLDER, kind: "folder", label: FOLDER_NAME, position: 30 });
  await upsertServerSidebarItem({ itemId: "sb-staff-chat", kind: "channel", channelId: STAFF_TEXT, position: 40, parentItemId: FOLDER });
  await upsertServerSidebarItem({ itemId: "sb-staff-room", kind: "channel", channelId: STAFF_VOICE, position: 50, parentItemId: FOLDER });
  await upsertServerSidebarItem({ itemId: "sb-announcements", kind: "channel", channelId: OWN, position: 60, parentItemId: FOLDER });
  await upsertServerSidebarItem({ itemId: "sb-loose", kind: "channel", channelId: LOOSE, position: 70 });

  resetChannelPermissionCache();
  resetChannelIdCache();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a folder whose permissions hide it from a member", () => {
  it("is an ordinary folder before it has any", async () => {
    const seen = await whatTheySee(member);
    assert.ok(seen.includes(FOLDER_NAME), "the member should see a folder nobody has narrowed");
    assert.ok(seen.includes(STAFF_TEXT));
  });

  it("turns the member out of a voice room in it when set", async () => {
    const h = harness(admin, [member], { [member.serverUserId]: STAFF_VOICE });
    await registerAdminChannelHandlers(h.ctx)["server:folders:scope:set"]({
      accessToken: admin.accessToken,
      folderId: FOLDER,
      custom: true,
      rules: denyReading,
    });

    assert.deepEqual(h.emitted.filter((e) => e.event === "server:error"), []);
    assert.ok(
      h.to(member).some((e) => e.event === "voice:room:leave"),
      "the member kept a seat in a room their folder just hid",
    );
    assert.equal(h.clientsInfo[`sock-${member.serverUserId}`].voiceChannelId, "");
  });

  it("never names the folder, or any channel in it, to the member", async () => {
    const seen = await whatTheySee(member);
    for (const hidden of [FOLDER, FOLDER_NAME, STAFF_TEXT, STAFF_VOICE, OWN]) {
      assert.equal(seen.includes(hidden), false, `"${hidden}" reached the member:\n${seen}`);
    }
    assert.ok(seen.includes(OPEN_TEXT), "filtering took the open channel with it");
  });

  it("still shows the folder and its channels to the admin", async () => {
    const seen = await whatTheySee(admin);
    for (const shown of [FOLDER_NAME, STAFF_TEXT, STAFF_VOICE, OWN]) {
      assert.ok(seen.includes(shown), `the admin lost "${shown}"`);
    }
  });

  it("refuses the member's read the way it refuses a channel that is not there", async () => {
    assert.deepEqual(await fetchAs(member, STAFF_TEXT), await fetchAs(member, "no-such-channel"));
    assert.deepEqual(await fetchAs(member, OPEN_TEXT), [{ event: "chat:history", payload: "history" }]);
  });

  it("refuses the member's message", async () => {
    assert.deepEqual(await sendAs(member, STAFF_TEXT), await sendAs(member, "no-such-channel"));
    assert.deepEqual(await sendAs(member, OPEN_TEXT), [], "the open channel should take the message");
  });

  it("refuses the member a seat in its voice room", async () => {
    const refused = await joinAs(member, STAFF_VOICE);
    assert.equal(refused.some((e) => e.event === "voice:room:granted"), false);
    assert.deepEqual(refused.map((e) => (e.payload as { error?: string }).error), ["not_found"]);
    assert.ok((await joinAs(member, OPEN_VOICE)).some((e) => e.event === "voice:room:granted"));
  });

  it("keeps the room out of the member list for the member", async () => {
    const h = harness(member, [admin], { [admin.serverUserId]: STAFF_VOICE });
    broadcastMemberList(h.ctx.io as never, h.clientsInfo, SERVER_ID);
    await new Promise((r) => setTimeout(r, 300));
    const lists = h.to(member).filter((e) => e.event === "members:list");
    assert.ok(lists.length > 0, "members:list was never sent");
    assert.equal(JSON.stringify(lists).includes(STAFF_VOICE), false);
  });

  it("tells the channel editor the channel follows its folder", async () => {
    const scope = await scopeOf(STAFF_TEXT);
    assert.equal(scope.followsFolder, true);
    assert.deepEqual(scope.folder, { id: FOLDER, name: FOLDER_NAME });
    assert.equal(scope.isTemplate, false, "a folder's own rules draw as Custom");
    assert.deepEqual(scope.rules, denyReading);
  });
});

describe("a channel with permissions of its own", () => {
  it("keeps them inside a hidden folder, and brings the folder back with it", async () => {
    await asAdmin("server:channels:scope:set", { channelId: OWN, templateId: null });

    const scope = await scopeOf(OWN);
    assert.equal(scope.followsFolder, false);
    assert.equal(scope.scopeId, null, "picking Everyone is a choice of the channel's own");

    const seen = await whatTheySee(member);
    assert.ok(seen.includes(OWN), "the member should see a channel open to everyone");
    assert.ok(seen.includes(FOLDER_NAME), "a folder with a channel they can see comes back");
    assert.equal(seen.includes(STAFF_TEXT), false, "only that channel, not its neighbours");
  });

  it("follows the folder again when told to", async () => {
    const h = await asAdmin("server:channels:scope:follow", { channelId: OWN });
    const reply = h.emitted.find((e) => e.event === "server:channels:scope")?.payload as { followsFolder: boolean };
    assert.equal(reply?.followsFolder, true, "the dialog should hear it follows again");

    const seen = await whatTheySee(member);
    assert.equal(seen.includes(OWN), false);
    assert.equal(seen.includes(FOLDER_NAME), false);
  });
});

describe("moving channels in and out of the folder", () => {
  it("makes a channel moved in follow the folder", async () => {
    await asAdmin("server:sidebar:reorder", { order: [{ itemId: "sb-loose", parentItemId: FOLDER }] });
    assert.equal((await whatTheySee(member)).includes(LOOSE), false);
    assert.equal((await scopeOf(LOOSE)).followsFolder, true);
  });

  it("lets a channel with its own permissions keep them when it moves in", async () => {
    await asAdmin("server:sidebar:reorder", { order: [{ itemId: "sb-loose", parentItemId: null }] });
    await asAdmin("server:channels:scope:set", { channelId: LOOSE, templateId: null });
    await asAdmin("server:sidebar:reorder", { order: [{ itemId: "sb-loose", parentItemId: FOLDER }] });

    assert.ok((await whatTheySee(member)).includes(LOOSE), "its own Everyone should outrank the folder");
    assert.equal((await scopeOf(LOOSE)).followsFolder, false);
  });

  it("keeps the folder's rules on a channel dragged out to the top", async () => {
    await asAdmin("server:sidebar:reorder", { order: [{ itemId: "sb-staff-chat", parentItemId: null }] });

    const scope = await scopeOf(STAFF_TEXT);
    assert.equal(scope.followsFolder, false, "at the top level it has nothing to follow");
    assert.deepEqual(scope.rules, denyReading, "it keeps what it had");
    assert.equal((await whatTheySee(member)).includes(STAFF_TEXT), false, "dragging it out opened it");

    await asAdmin("server:sidebar:reorder", { order: [{ itemId: "sb-staff-chat", parentItemId: FOLDER }] });
    await asAdmin("server:channels:scope:follow", { channelId: STAFF_TEXT });
  });

  it("needs manage_channels to move a following channel into a folder with other rules", async () => {
    const h = harness(arranger);
    await registerAdminChannelHandlers(h.ctx)["server:sidebar:reorder"]({
      accessToken: arranger.accessToken,
      order: [{ itemId: "sb-staff-chat", parentItemId: null }, { itemId: "sb-open", parentItemId: FOLDER }],
    });
    const refused = h.emitted.find((e) => e.event === "server:error")?.payload as { permission?: string };
    assert.equal(refused?.permission, "manage_channels");

    const open = (await listServerSidebarItems()).find((i) => i.item_id === "sb-open");
    assert.equal(open?.parent_item_id, null, "a refused reorder should move nothing");
  });

  it("lets somebody with only manage_sidebar reorder inside the folder", async () => {
    const h = harness(arranger);
    await registerAdminChannelHandlers(h.ctx)["server:sidebar:reorder"]({
      accessToken: arranger.accessToken,
      order: [
        { itemId: "sb-staff-room", parentItemId: FOLDER },
        { itemId: "sb-staff-chat", parentItemId: FOLDER },
      ],
    });
    assert.deepEqual(h.emitted.filter((e) => e.event === "server:error"), []);
  });

  it("creates a channel in the folder without showing it outside first", async () => {
    const h = harness(admin, [member]);
    await registerAdminChannelHandlers(h.ctx)["server:channels:upsert"]({
      accessToken: admin.accessToken,
      channelId: "fp-new",
      name: "New in staff",
      type: "text",
      parentItemId: FOLDER,
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(JSON.stringify(h.to(member)).includes("fp-new"), false, "the new channel was broadcast to the member");
    assert.equal((await scopeOf("fp-new")).followsFolder, true);
  });

  it("keeps the folder's rules on its channels when the folder is deleted", async () => {
    await asAdmin("server:sidebar:item:upsert", { itemId: "sb-fold-temp", kind: "folder", label: "Temporary", position: 80 });
    await asAdmin("server:folders:scope:set", { folderId: "sb-fold-temp", custom: true, rules: denyReading });
    await asAdmin("server:sidebar:reorder", { order: [{ itemId: "sb-loose", parentItemId: "sb-fold-temp" }] });
    await asAdmin("server:channels:scope:follow", { channelId: LOOSE });
    assert.equal((await whatTheySee(member)).includes(LOOSE), false);

    await asAdmin("server:sidebar:item:delete", { itemId: "sb-fold-temp" });

    assert.equal((await whatTheySee(member)).includes(LOOSE), false, "deleting the folder opened its channel");
    const loose = (await listServerChannels()).find((c) => c.channel_id === LOOSE);
    assert.ok(loose?.permission_scope_id, "the channel should have its own copy now");
    assert.deepEqual(
      (await listPermissionRules(loose.permission_scope_id)).map((r) => ({ roleId: r.role_id, permission: r.permission, effect: r.effect })),
      denyReading,
    );
  });
});

describe("a folder on a template", () => {
  let templateId = "";

  it("counts the channels following it as the template's", async () => {
    const saved = await asAdmin("server:permissions:template:save", { name: "Staff only", rules: denyReading });
    assert.ok(saved);
    const list = await asAdmin("server:permissions:templates:list", {});
    const templates = (list.emitted.find((e) => e.event === "server:permissions:templates")?.payload as {
      templates: { id: string; name: string; channelCount: number }[];
    }).templates;
    templateId = templates.find((t) => t.name === "Staff only")!.id;

    await asAdmin("server:folders:scope:set", { folderId: FOLDER, templateId });
    const after = await asAdmin("server:permissions:templates:list", {});
    const counted = (after.emitted.find((e) => e.event === "server:permissions:templates")?.payload as {
      templates: { id: string; channelCount: number }[];
    }).templates.find((t) => t.id === templateId);
    assert.equal(counted?.channelCount, 4, "staff chat, staff room, announcements and the new one follow it");
    assert.equal((await whatTheySee(member)).includes(FOLDER_NAME), false);
  });

  it("opens the folder when the template is deleted", async () => {
    await asAdmin("server:permissions:template:delete", { templateId });
    const seen = await whatTheySee(member);
    assert.ok(seen.includes(FOLDER_NAME));
    assert.ok(seen.includes(STAFF_TEXT));
  });
});

describe("a folder that shuts its rooms without hiding them", () => {
  it("shows the room and refuses the seat", async () => {
    await asAdmin("server:folders:scope:set", {
      folderId: FOLDER,
      custom: true,
      rules: [{ roleId: MEMBER_ROLE, permission: "join_voice", effect: "deny" }],
    });

    assert.ok((await whatTheySee(member)).includes(STAFF_VOICE), "join_voice alone should not hide the room");
    const refused = await joinAs(member, STAFF_VOICE);
    assert.equal(refused.some((e) => e.event === "voice:room:granted"), false, "the SFU was asked for a shut room");
    assert.equal((refused[0]?.payload as { permission?: string })?.permission, "join_voice");
  });
});
