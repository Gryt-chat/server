import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { ensureDefaultChannels } from "../../db/sqlite/channels";
import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { openDirectConversation } from "../../db/sqlite/conversations";
import { listServerAudit } from "../../db/sqlite/invites";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, getServerConfig, setServerRole, updateServerConfig } from "../../db/sqlite/servers";
import { getUserByServerId, setUserModerationState, upsertUser } from "../../db/sqlite/users";
import { spamFilter } from "../../moderation/spamFilter";
import { announceMute } from "../../moderation/timeout";
import { applyServerSettings, settingsView } from "../../settings/serverSettings";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { refreshClientPermissions } from "../utils/standing";
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/** Through `chat:send`, so what is proved is that the handler asks, drops the
    message, and writes the same timeout a moderator would. */

const HOST = "spam.test:5001";
let dir: string;

interface Emitted {
  event: string;
  payload: unknown;
}

interface Member {
  serverUserId: string;
  accessToken: string;
  emitted: Emitted[];
  handlers: EventHandlerMap;
  send: (conversationId: string, body: { text?: string; sealed?: string }) => Promise<void>;
  refusals: () => { error?: string; reason?: string; expiresAt?: string | null }[];
  delivered: () => number;
}

const clientsInfo: Clients = {};
const sockets = new Map<string, { emit: (event: string, payload?: unknown) => boolean }>();
const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets } };

let seq = 0;
async function connect(roleId: string, opts: { joinedMinutesAgo?: number } = {}): Promise<Member> {
  seq += 1;
  const clientId = `spam-socket-${seq}`;
  const grytUserId = `account-spam-${seq}`;
  const nickname = `Spam${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, roleId);
  const joined = new Date(Date.now() - (opts.joinedMinutesAgo ?? 60 * 24 * 30) * 60_000);
  getSqliteDb().prepare(`UPDATE users SET created_at = ? WHERE server_user_id = ?`).run(joined.toISOString(), user.server_user_id);

  const emitted: Emitted[] = [];
  const record = (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
    return true;
  };
  sockets.set(clientId, { emit: record });
  clientsInfo[clientId] = {
    serverUserId: user.server_user_id,
    grytUserId,
    nickname,
    hasJoinedChannel: false,
    voiceChannelId: "",
    isMuted: false,
    isDeafened: false,
    isServerMuted: false,
    isServerDeafened: false,
  } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);

  const ctx = {
    io,
    socket: { id: clientId, handshake: { headers: { host: HOST }, address: "127.0.0.1" }, emit: record, join() {}, leave() {}, to: () => ({ emit() {} }) },
    clientId,
    serverId: "spam-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.9.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  const handlers = registerChatHandlers(ctx);
  const accessToken = generateAccessToken({ grytUserId, serverUserId: user.server_user_id, nickname, serverHost: HOST, tokenVersion: 0 });

  let nonce = 0;
  return {
    serverUserId: user.server_user_id,
    accessToken,
    emitted,
    handlers,
    send: async (conversationId, body) => {
      nonce += 1;
      await handlers["chat:send"]({ conversationId, accessToken, nonce: `n${seq}-${nonce}`, ...body });
    },
    refusals: () =>
      emitted
        .filter((e) => e.event === "chat:error")
        .map((e) => e.payload as { error?: string; reason?: string; expiresAt?: string | null }),
    delivered: () =>
      emitted.filter((e) => e.event === "chat:new" && (e.payload as { sender_server_id?: string })?.sender_server_id === user.server_user_id).length,
  };
}

async function spamAudit(target: string) {
  return (await listServerAudit(200)).filter((a) => a.action === "spam_timeout" && a.target === target);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-spam-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await ensureDefaultChannels();
  resetChannelIdCache();
  await createRoleDefinition("talker", { name: "Talker", rank: 50, permissions: ["read_messages", "send_messages", "send_direct_messages"] });
  await createRoleDefinition("announcer", { name: "Announcer", rank: 55, permissions: ["read_messages", "send_messages", "mention_everyone"] });
  await createRoleDefinition("spam-mod", { name: "Spam mod", rank: 60, permissions: ["read_messages", "send_messages", "mute_members", "mention_everyone"] });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  spamFilter.reset();
  resetRateLimits();
  await updateServerConfig({ spamFilter: true, spamSensitivity: "normal" });
});

describe("the spam filter on chat:send", () => {
  it("drops the fourth copy, times the sender out for a minute, and writes it down", async () => {
    const spammer = await connect("talker");
    for (let i = 0; i < 4; i++) await spammer.send("general", { text: "buy cheap followers at spamsite dot com" });

    assert.equal(spammer.delivered(), 3, "three copies go out before it trips");
    const [refused] = spammer.refusals();
    assert.equal(refused?.error, "muted", "the client settles a muted refusal");
    assert.equal(refused?.reason, "spam");

    const row = await getUserByServerId(spammer.serverUserId);
    assert.equal(row?.is_server_muted, true);
    const minutes = ((row?.server_mute_expires_at?.getTime() ?? 0) - Date.now()) / 60_000;
    assert.ok(minutes > 0.9 && minutes <= 1, `timeout of ${minutes} minutes`);

    const pushed = spammer.emitted.find((e) => e.event === "server:muted")?.payload as { reason?: string; muted?: boolean };
    assert.deepEqual({ muted: pushed?.muted, reason: pushed?.reason }, { muted: true, reason: "spam" });

    const [entry] = await spamAudit(spammer.serverUserId);
    assert.ok(entry, "an audit row names the timeout");
    assert.equal(entry.actor_server_user_id, null, "the server did it, not a member");
    const meta = JSON.parse(entry.meta_json ?? "{}");
    assert.ok(meta.signals.duplicate > 0);
    assert.equal(meta.minutes, 1);
    assert.equal(meta.strike, 1);
    assert.equal(meta.in, "channel");
    assert.ok(!JSON.stringify(meta).includes("general"), "no channel id in the meta, which the audit list does not filter");

    await spammer.send("general", { text: "one more" });
    assert.equal(spammer.delivered(), 3, "the timeout holds");
  });

  it("escalates: the second strike this week is ten minutes", async () => {
    const spammer = await connect("talker");
    for (let i = 0; i < 4; i++) await spammer.send("general", { text: "follow my channel for free coins now" });
    await setUserModerationState(spammer.serverUserId, { muted: false });
    resetRateLimits();
    for (let i = 0; i < 4; i++) await spammer.send("general", { text: "follow my channel for free coins now" });

    const row = await getUserByServerId(spammer.serverUserId);
    const minutes = ((row?.server_mute_expires_at?.getTime() ?? 0) - Date.now()) / 60_000;
    assert.ok(minutes > 9.9 && minutes <= 10, `timeout of ${minutes} minutes`);
    const strikes = (await spamAudit(spammer.serverUserId)).map((a) => JSON.parse(a.meta_json ?? "{}").minutes).sort((a, b) => a - b);
    assert.deepEqual(strikes, [1, 10]);
  });

  it("never touches a moderator, even posting @everyone again and again", async () => {
    const mod = await connect("spam-mod");
    for (let i = 0; i < 6; i++) await mod.send("general", { text: "@everyone server maintenance in five minutes" });
    assert.equal(mod.delivered(), 6);
    assert.deepEqual(await spamAudit(mod.serverUserId), []);
  });

  it("lets a member allowed to ping everyone post one announcement", async () => {
    const announcer = await connect("announcer", { joinedMinutesAgo: 5 });
    await announcer.send("general", { text: "@everyone game night starts at 8 in voice" });
    await announcer.send("general", { text: "bring snacks" });
    assert.equal(announcer.delivered(), 2);
    assert.deepEqual(await spamAudit(announcer.serverUserId), []);
  });

  it("does nothing when the owner has switched it off", async () => {
    await updateServerConfig({ spamFilter: false });
    const spammer = await connect("talker");
    for (let i = 0; i < 6; i++) await spammer.send("general", { text: "buy cheap followers at spamsite dot com" });
    assert.equal(spammer.delivered(), 6);
    assert.deepEqual(await spamAudit(spammer.serverUserId), []);
  });

  it("judges a DM fan-out on metadata, and names no conversation in the audit row", async () => {
    const spammer = await connect("talker", { joinedMinutesAgo: 2 });
    const targets: Member[] = [];
    for (let i = 0; i < 8; i++) targets.push(await connect("talker"));

    const envelope = JSON.stringify({ type: "gryt-sealed-message", version: 1, body: "c3BhbQ", keys: {} });
    let sent = 0;
    const conversationIds: string[] = [];
    for (const t of targets) {
      const conversation = await openDirectConversation(spammer.serverUserId, t.serverUserId);
      conversationIds.push(conversation.conversation_id);
      await spammer.send(conversation.conversation_id, { sealed: envelope });
      if (spammer.refusals().length > 0) break;
      sent += 1;
    }

    assert.equal(sent, 4, "four reach somebody before the fifth trips it");
    const [entry] = await spamAudit(spammer.serverUserId);
    const meta = JSON.parse(entry?.meta_json ?? "{}");
    assert.equal(meta.in, "dm");
    assert.equal(meta.newMemberWeight, 2);
    assert.ok(meta.signals.dm_new_conversations > 0);
    for (const id of conversationIds) assert.ok(!(entry?.meta_json ?? "").includes(id), "no conversation id in the meta");
    assert.ok(!(entry?.meta_json ?? "").includes(targets[0].serverUserId), "nor who was messaged");
  });

  it("leaves a normal member chatting in the same run alone", async () => {
    const spammer = await connect("talker");
    const normal = await connect("talker", { joinedMinutesAgo: 3 });
    const lines = ["hey all", "anyone up for a game later", "I can host", "voice 2 then", "check https://example.com/rules first", "ok see you"];
    for (let i = 0; i < lines.length; i++) {
      await spammer.send("general", { text: "free coins at spamsite dot com hurry" });
      await normal.send("general", { text: lines[i] });
    }
    assert.equal(normal.delivered(), lines.length);
    assert.deepEqual(normal.refusals(), []);
    assert.equal((await spamAudit(spammer.serverUserId)).length, 1);
  });
});

describe("when a timeout lapses", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pushes = (m: Member) => m.emitted.filter((e) => e.event === "server:muted").map((e) => (e.payload as { muted: boolean }).muted);

  async function timeOut(m: Member, ms: number) {
    const until = new Date(Date.now() + ms);
    await setUserModerationState(m.serverUserId, { muted: true, mutedUntil: until });
    announceMute({ io: io as never, clientsInfo, sfuClient: null, serverId: "spam-test", serverUserId: m.serverUserId, muted: true, until });
  }

  it("tells the member's connections, so voice and the member list catch up", async () => {
    const m = await connect("talker");
    await timeOut(m, 100);
    await sleep(600);
    assert.deepEqual(pushes(m), [true, false]);
  });

  it("leaves a mute a moderator made indefinite in the meantime", async () => {
    const m = await connect("talker");
    await timeOut(m, 100);
    await setUserModerationState(m.serverUserId, { muted: true, mutedUntil: null });
    await sleep(600);
    assert.deepEqual(pushes(m), [true]);
  });
});

describe("spam filter settings", () => {
  it("defaults to on at normal, and takes the owner's change", async () => {
    await updateServerConfig({ spamFilter: true, spamSensitivity: "normal" });
    let view = settingsView((await getServerConfig())!, "s", true);
    assert.deepEqual([view.spamFilter, view.spamSensitivity], [true, "normal"]);

    await applyServerSettings({ spamFilter: false, spamSensitivity: "high" }, { serverUserId: null, via: "management" });
    view = settingsView((await getServerConfig())!, "s", true);
    assert.deepEqual([view.spamFilter, view.spamSensitivity], [false, "high"]);

    await applyServerSettings({ spamSensitivity: "extreme" }, { serverUserId: null, via: "management" });
    view = settingsView((await getServerConfig())!, "s", true);
    assert.equal(view.spamSensitivity, "high", "an unknown value is ignored, not stored");
  });
});
