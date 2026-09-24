import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { ChannelPermission, Permission } from "../../constants/permissions";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { initSqlite } from "../../db/sqlite/connection";
import { getMessageById, insertFile, insertMessage } from "../../db/sqlite/messages";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { createThread } from "../../db/sqlite/threads";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { registerChatHandlers } from "./chat";
import { registerReportHandlers } from "./reports";
import type { HandlerContext } from "./types";
import { registerVoiceHandlers } from "./voice";

/**
 * Each channel permission, with a role that holds it server-wide and a channel
 * that denies it: refused there, allowed in a channel that says nothing (GRYT-1346).
 */

const HOST = "channel-rules.test:5001";
const SERVER_ID = "channel-rules-test";

const OPEN = "cr-open";
const OPEN_ROOM = "cr-open-room";
const MEMBER_ROLE = "cr-member";
const MOD_ROLE = "cr-mod";
const LIMITED_ROLE = "cr-limited";

/** One channel per permission, denying only that one to both roles. */
const deniedIn = (permission: ChannelPermission) => `cr-no-${permission}`;
const deniedRoom = (permission: ChannelPermission) => `cr-no-${permission}-room`;

const TEXT_RULES: ChannelPermission[] = [
  "attach_files",
  "add_reactions",
  "edit_own_messages",
  "delete_own_messages",
  "manage_messages",
  "report_messages",
];
const VOICE_RULES: ChannelPermission[] = ["share_video", "share_screen"];

const basics: Permission[] = [
  "read_messages", "send_messages", "view_members", "join_voice", "speak",
  "attach_files", "add_reactions", "edit_own_messages", "delete_own_messages",
  "report_messages", "share_video", "share_screen",
];

let dir: string;

async function memberWith(name: string, roleId: string) {
  const grytUserId = `account-cr-${name}`;
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
let other: Member;
let mod: Member;
let limited: Member;

interface Emitted {
  event: string;
  payload: unknown;
}

const fakeSfu = {
  isConnected: () => true,
  registerRoom: async () => {},
  generateClientJoinToken: (roomId: string, userId: string) => ({ room_id: roomId, user_token: "stub", user_id: userId }),
  getActiveUsers: () => new Map(),
  untrackUserConnection: () => {},
};

let ipSeq = 0;

function harness(self: Member, voiceChannelId = "") {
  const emitted: Emitted[] = [];
  const clientId = `sock-${self.serverUserId}`;
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
    [clientId]: {
      serverUserId: self.serverUserId,
      grytUserId: self.grytUserId,
      nickname: self.grytUserId,
      permissions: new Set<Permission>(basics),
      voiceChannelId,
      isConnectedToVoice: Boolean(voiceChannelId),
      hasJoinedChannel: Boolean(voiceChannelId),
    } as unknown as Clients[string],
  };
  const io = {
    to() {
      return { emit() {} };
    },
    emit() {},
    sockets: { sockets: new Map([[clientId, socket]]) },
  };
  // A fresh address each time, so the rate limiter never answers for a gate.
  ipSeq += 1;
  const ip = `10.46.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
  const ctx = {
    io,
    socket,
    clientId,
    serverId: SERVER_ID,
    clientsInfo,
    sfuClient: fakeSfu,
    getClientIp: () => ip,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  const client = clientsInfo[clientId] as unknown as Record<string, unknown>;
  return { ctx, emitted, client };
}

/** Every `forbidden` this socket was sent, by the permission it named. */
function refusedFor(emitted: Emitted[]): string[] {
  return emitted
    .map((e) => e.payload as { error?: string; permission?: string } | undefined)
    .filter((p) => p && typeof p === "object" && p.error === "forbidden")
    .map((p) => String(p!.permission));
}

async function post(conversationId: string, sender: Member, text = "hello") {
  return insertMessage({
    conversation_id: conversationId,
    sender_server_id: sender.serverUserId,
    text,
    attachments: null,
    reactions: null,
  } as Parameters<typeof insertMessage>[0]);
}

async function chat(who: Member, event: string, payload: Record<string, unknown>) {
  const h = harness(who);
  await registerChatHandlers(h.ctx)[event]({ accessToken: who.accessToken, ...payload });
  return h;
}

async function report(who: Member, payload: Record<string, unknown>) {
  const h = harness(who);
  await registerReportHandlers(h.ctx)["chat:report"]({ accessToken: who.accessToken, ...payload });
  return h;
}

/** What each permission's action looks like, in one channel, as one member. */
const act: Record<string, (channelId: string, who: Member) => Promise<Emitted[]>> = {
  async attach_files(channelId, who) {
    const fileId = `file-${channelId}-${who.serverUserId}`;
    await insertFile({
      file_id: fileId,
      s3_key: `uploads/${fileId}.txt`,
      mime: "text/plain",
      size: 4,
      width: null,
      height: null,
      thumbnail_key: null,
      original_name: "a.txt",
      uploaded_by_server_user_id: who.serverUserId,
    } as Parameters<typeof insertFile>[0]);
    return (await chat(who, "chat:send", { conversationId: channelId, text: "see file", attachments: [fileId] })).emitted;
  },
  async add_reactions(channelId, who) {
    const m = await post(channelId, other);
    return (await chat(who, "chat:react", { conversationId: channelId, messageId: m.message_id, reactionSrc: "👍" })).emitted;
  },
  async edit_own_messages(channelId, who) {
    const m = await post(channelId, who);
    return (await chat(who, "chat:edit", { conversationId: channelId, messageId: m.message_id, text: "edited" })).emitted;
  },
  async delete_own_messages(channelId, who) {
    const m = await post(channelId, who);
    return (await chat(who, "chat:delete", { conversationId: channelId, messageId: m.message_id })).emitted;
  },
  async manage_messages(channelId, who) {
    const m = await post(channelId, other);
    return (await chat(who, "chat:delete", { conversationId: channelId, messageId: m.message_id })).emitted;
  },
  async report_messages(channelId, who) {
    const m = await post(channelId, other);
    return (await report(who, { conversationId: channelId, messageId: m.message_id })).emitted;
  },
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-channel-rules-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await createRoleDefinition(MEMBER_ROLE, { name: "Member", rank: 10, permissions: basics });
  await createRoleDefinition(MOD_ROLE, { name: "Mod", rank: 50, permissions: [...basics, "manage_messages"] });
  // Nothing server-wide past reading and sending, for the channel that allows.
  await createRoleDefinition(LIMITED_ROLE, { name: "Limited", rank: 5, permissions: ["read_messages", "send_messages", "view_members"] });

  member = await memberWith("member", MEMBER_ROLE);
  other = await memberWith("other", MEMBER_ROLE);
  mod = await memberWith("mod", MOD_ROLE);
  limited = await memberWith("limited", LIMITED_ROLE);

  await upsertServerChannel({ channelId: OPEN, name: "Open", type: "text" });
  await upsertServerChannel({ channelId: OPEN_ROOM, name: "Open room", type: "voice" });

  const scoped = async (channelId: string, type: "text" | "voice", rules: { roleId: string; permission: string; effect: string }[]) => {
    await upsertServerChannel({ channelId, name: channelId, type });
    const scopeId = await createPermissionScope({ scopeId: `scope-${channelId}` });
    await replacePermissionRules(scopeId, rules);
    await setChannelPermissionScope(channelId, scopeId);
  };
  const denyBoth = (permission: string) =>
    [MEMBER_ROLE, MOD_ROLE].map((roleId) => ({ roleId, permission, effect: "deny" }));

  for (const p of TEXT_RULES) await scoped(deniedIn(p), "text", denyBoth(p));
  for (const p of VOICE_RULES) await scoped(deniedRoom(p), "voice", denyBoth(p));
  await scoped("cr-reactions-allowed", "text", [{ roleId: LIMITED_ROLE, permission: "add_reactions", effect: "allow" }]);

  resetChannelPermissionCache();
  resetChannelIdCache();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a text permission denied in one channel", () => {
  for (const permission of TEXT_RULES) {
    // manage_messages is the moderator's; the rest are an ordinary member's.
    const who = () => (permission === "manage_messages" ? mod : member);

    it(`${permission} is refused there`, async () => {
      const emitted = await act[permission](deniedIn(permission), who());
      assert.ok(
        refusedFor(emitted).includes(permission),
        `${permission} went through in a channel that denies it: ${JSON.stringify(emitted)}`,
      );
    });

    it(`${permission} is allowed in a channel that says nothing`, async () => {
      const emitted = await act[permission](OPEN, who());
      assert.deepEqual(refusedFor(emitted), [], `${permission} refused in an open channel: ${JSON.stringify(emitted)}`);
      assert.equal(emitted.some((e) => e.event === "chat:error"), false, JSON.stringify(emitted));
    });
  }

  it("keeps the message a moderator was refused deleting", async () => {
    const m = await post(deniedIn("manage_messages"), other);
    await chat(mod, "chat:delete", { conversationId: deniedIn("manage_messages"), messageId: m.message_id });
    assert.ok(await getMessageById(deniedIn("manage_messages"), m.message_id));
  });

  it("stops a moderator settling somebody else's topic there", async () => {
    const channel = deniedIn("manage_messages");
    const root = await post(channel, other, "a question");
    const thread = await createThread({ conversation_id: channel, root_message_id: root.message_id, created_by: other.serverUserId, title: "Q" });
    const refused = await chat(mod, "thread:status:set", { conversationId: channel, threadId: thread.thread_id, status: "solved" });
    assert.ok(refusedFor(refused.emitted).includes("manage_messages"));

    const openRoot = await post(OPEN, other, "another");
    const openThread = await createThread({ conversation_id: OPEN, root_message_id: openRoot.message_id, created_by: other.serverUserId, title: "Q" });
    const allowed = await chat(mod, "thread:status:set", { conversationId: OPEN, threadId: openThread.thread_id, status: "solved" });
    assert.deepEqual(refusedFor(allowed.emitted), []);
  });
});

describe("a channel that allows what the role cannot elsewhere", () => {
  it("lets the role react there and nowhere else", async () => {
    assert.deepEqual(refusedFor(await act.add_reactions("cr-reactions-allowed", limited)), []);
    assert.ok(refusedFor(await act.add_reactions(OPEN, limited)).includes("add_reactions"));
  });
});

describe("a voice permission denied in one room", () => {
  const events: Record<string, string> = { share_video: "voice:camera:state", share_screen: "voice:screen:state" };
  const flag: Record<string, string> = { share_video: "cameraEnabled", share_screen: "screenShareEnabled" };

  for (const permission of VOICE_RULES) {
    it(`${permission} is refused there`, async () => {
      const h = harness(member, deniedRoom(permission));
      await registerVoiceHandlers(h.ctx)[events[permission]]({ enabled: true });
      assert.ok(refusedFor(h.emitted).includes(permission));
      assert.notEqual(h.client[flag[permission]], true);
    });

    it(`${permission} is allowed in a room that says nothing`, async () => {
      const h = harness(member, OPEN_ROOM);
      await registerVoiceHandlers(h.ctx)[events[permission]]({ enabled: true });
      assert.deepEqual(refusedFor(h.emitted), []);
      assert.equal(h.client[flag[permission]], true);
    });

    it(`${permission} carried into a room that denies it is dropped at the grant`, async () => {
      const h = harness(member, OPEN_ROOM);
      h.client[flag[permission]] = true;
      await registerVoiceHandlers(h.ctx)["voice:room:request"](deniedRoom(permission));
      assert.ok(h.emitted.some((e) => e.event === "voice:room:granted"), JSON.stringify(h.emitted));
      assert.equal(h.client[flag[permission]], false);
    });

    it(`${permission} carried into an open room is kept`, async () => {
      const h = harness(member, OPEN_ROOM);
      h.client[flag[permission]] = true;
      await registerVoiceHandlers(h.ctx)["voice:room:request"](OPEN_ROOM);
      assert.ok(h.emitted.some((e) => e.event === "voice:room:granted"), JSON.stringify(h.emitted));
      assert.equal(h.client[flag[permission]], true);
    });
  }
});
