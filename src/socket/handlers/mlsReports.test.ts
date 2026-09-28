import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { createGroupConversation, openDirectConversation } from "../../db/sqlite/conversations";
import { insertMessage } from "../../db/sqlite/messages";
import { listReports } from "../../db/sqlite/reports";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import { registerReportHandlers } from "./reports";
import type { EventHandlerMap, HandlerContext } from "./types";

/** Reporting an MLS message: the reporter's copy, and who may send one (GRYT-1557). */

const HOST = "mlsreports.test:5001";

let dir: string;

interface Emitted {
  event: string;
  payload: unknown;
}

interface Actor {
  clientId: string;
  serverUserId: string;
  grytUserId: string;
  accessToken: string;
  emitted: Emitted[];
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
  clear: () => void;
}

/** `disconnect` is here because `evictUser` calls it, and a stub without it
    throws into a catch that looks exactly like a permission check firing. */
interface FakeSocket {
  emit: (event: string, payload?: unknown) => boolean;
  disconnect: () => void;
  disconnected: boolean;
}
const sockets = new Map<string, FakeSocket>();
const clientsInfo: Clients = {};
const io = {
  to() {
    return { emit() {} };
  },
  emit() {},
  sockets: { sockets },
};

let seq = 0;

/** `rank` rises with the permission set: the moderators below have to outrank
    their targets, and a tie is refused before any permission is read. */
async function connect(nickname: string, permissions: Permission[], rank = 10): Promise<Actor> {
  seq += 1;
  const clientId = `socket-${seq}`;
  const roleId = `role-${seq}`;
  const grytUserId = `account-mls-report-${seq}`;

  await createRoleDefinition(roleId, { name: `Role ${seq}`, rank, permissions });
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, roleId);

  const emitted: Emitted[] = [];
  const socket = {
    id: clientId,
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
    disconnect() {},
  };

  const fake: FakeSocket = {
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    disconnect() {
      fake.disconnected = true;
    },
    disconnected: false,
  };
  sockets.set(clientId, fake);

  clientsInfo[clientId] = {
    serverUserId: user.server_user_id,
    grytUserId,
    nickname,
    color: "#666666",
    isMuted: false,
    isDeafened: false,
    streamID: "",
    hasJoinedChannel: false,
    voiceChannelId: "",
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
  } as Clients[string];

  const ctx = {
    io,
    socket,
    clientId,
    serverId: "mls-reports-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.1.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    clientId,
    serverUserId: user.server_user_id,
    grytUserId,
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname,
      serverHost: HOST,
      tokenVersion: 0,
    }),
    emitted,
    handlers: registerReportHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    clear: () => {
      emitted.length = 0;
    },
  };
}

const REPORTER: Permission[] = ["read_messages", "view_members", "report_messages"];
const MOD: Permission[] = [...REPORTER, "view_reports", "manage_reports"];

interface Card {
  messageId: string;
  conversationId: string;
  messageText: string | null;
  senderServerUserId: string;
  senderNickname: string | null;
  reportCount: number;
  unverified?: boolean;
}

async function cards(mod: Actor): Promise<Card[]> {
  mod.clear();
  await mod.handlers["reports:list"]({ accessToken: mod.accessToken });
  const payload = mod.received("reports:list").at(-1) as { reports?: Card[] } | undefined;
  return payload?.reports ?? [];
}

async function reportCopy(who: Actor, conversationId: string, messageId: string, mls: unknown): Promise<void> {
  // The limit has its own test below; here it would refuse the fifth case for the wrong reason.
  resetRateLimits();
  who.clear();
  await who.handlers["chat:report"]({ accessToken: who.accessToken, conversationId, messageId, mls });
}

const errors = (a: Actor) => a.received("chat:error");

let alice: Actor;
let bob: Actor;
let carol: Actor;
let mod: Actor;
let dm: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-mls-reports-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  alice = await connect("Alice", REPORTER);
  bob = await connect("Bob", REPORTER);
  carol = await connect("Carol", REPORTER);
  mod = await connect("Mod", MOD, 50);
  dm = (await openDirectConversation(alice.serverUserId, bob.serverUserId)).conversation_id;
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("reporting an MLS message", () => {
  it("queues the reporter's copy, marked unverified, under the sender", async () => {
    await reportCopy(alice, dm, "mls-1", { senderServerUserId: bob.serverUserId, text: "something awful" });
    assert.deepEqual(alice.received("report:submitted"), [{ messageId: "mls-1" }]);
    const card = (await cards(mod)).find((c) => c.messageId === "mls-1");
    assert.ok(card);
    assert.equal(card.conversationId, dm);
    assert.equal(card.messageText, "something awful");
    assert.equal(card.senderServerUserId, bob.serverUserId);
    assert.equal(card.senderNickname, "Bob");
    assert.equal(card.unverified, true);
  });

  it("refuses a second report of the same message from the same person", async () => {
    await reportCopy(alice, dm, "mls-1", { senderServerUserId: bob.serverUserId, text: "again" });
    assert.deepEqual(alice.received("report:already_reported"), [{ messageId: "mls-1" }]);
    assert.equal((await listReports("pending")).filter((r) => r.message_id === "mls-1").length, 1);
  });

  it("refuses your own message", async () => {
    await reportCopy(alice, dm, "mls-own", { senderServerUserId: alice.serverUserId, text: "mine" });
    assert.deepEqual(errors(alice), ["You cannot report your own message"]);
  });

  it("refuses somebody outside the DM, as either reporter or sender, the same way", async () => {
    await reportCopy(carol, dm, "mls-2", { senderServerUserId: bob.serverUserId, text: "made up" });
    assert.deepEqual(errors(carol), ["Message not found"]);
    await reportCopy(alice, dm, "mls-3", { senderServerUserId: carol.serverUserId, text: "made up" });
    assert.deepEqual(errors(alice), ["Message not found"]);
    await reportCopy(alice, "general", "mls-4", { senderServerUserId: bob.serverUserId, text: "a channel" });
    assert.deepEqual(errors(alice), ["Message not found"]);
    await reportCopy(alice, "dm_0000", "mls-5", { senderServerUserId: bob.serverUserId, text: "no such DM" });
    assert.deepEqual(errors(alice), ["Message not found"]);
    assert.equal((await listReports("pending")).some((r) => ["mls-2", "mls-3", "mls-4", "mls-5"].includes(r.message_id)), false);
  });

  it("takes a member's report in a group DM", async () => {
    const group = (await createGroupConversation(alice.serverUserId, [bob.serverUserId, carol.serverUserId])).conversation_id;
    await reportCopy(carol, group, "mls-group", { senderServerUserId: bob.serverUserId, text: "in the group" });
    assert.deepEqual(carol.received("report:submitted"), [{ messageId: "mls-group" }]);
  });

  it("refuses a copy that isn't one", async () => {
    for (const bad of [
      null,
      "text",
      { text: "x" },
      { senderServerUserId: "", text: "x" },
      { senderServerUserId: 5, text: "x" },
      { senderServerUserId: "x", text: 5 },
      { senderServerUserId: "x", text: "x".repeat(32_001) },
    ]) {
      await reportCopy(bob, dm, "mls-bad", bad);
      assert.deepEqual(errors(bob), ["Invalid report payload"], JSON.stringify(bad)?.slice(0, 60));
    }
    await reportCopy(bob, dm, "i".repeat(65), { senderServerUserId: alice.serverUserId, text: "x" });
    assert.deepEqual(errors(bob), ["Invalid report payload"]);
  });

  it("needs report_messages like any report", async () => {
    const nobody = await connect("Nobody", ["read_messages"]);
    const theirs = (await openDirectConversation(nobody.serverUserId, bob.serverUserId)).conversation_id;
    await reportCopy(nobody, theirs, "mls-6", { senderServerUserId: bob.serverUserId, text: "x" });
    assert.equal((errors(nobody)[0] as { error?: string }).error, "forbidden");
  });

  it("keeps a copy whose id repeats a real message's apart from that message's reports", async () => {
    const real = await insertMessage({
      conversation_id: "general",
      sender_server_id: bob.serverUserId,
      text: "a real message",
      attachments: null,
      reactions: null,
    } as never);
    await carol.handlers["chat:report"]({ accessToken: carol.accessToken, conversationId: "general", messageId: real.message_id });
    await reportCopy(alice, dm, real.message_id, { senderServerUserId: bob.serverUserId, text: "a fake copy" });
    const both = (await cards(mod)).filter((c) => c.messageId === real.message_id);
    assert.equal(both.length, 2);
    const channelCard = both.find((c) => c.conversationId === "general")!;
    assert.equal(channelCard.messageText, "a real message");
    assert.equal(channelCard.reportCount, 1);
    assert.equal("unverified" in channelCard, false);

    // Dismissing the copy leaves the real report, and deleting it deletes nothing on the server.
    mod.clear();
    await mod.handlers["reports:resolve"]({ accessToken: mod.accessToken, messageId: real.message_id, conversationId: dm, action: "delete" });
    const left = (await cards(mod)).filter((c) => c.messageId === real.message_id);
    assert.deepEqual(left.map((c) => c.conversationId), ["general"]);
  });

  it("is rate-limited like any other report", async () => {
    resetRateLimits();
    const dave = await connect("Dave", REPORTER);
    const theirs = (await openDirectConversation(dave.serverUserId, bob.serverUserId)).conversation_id;
    const answers: string[] = [];
    for (let i = 0; i < 8; i++) {
      dave.clear();
      await dave.handlers["chat:report"]({
        accessToken: dave.accessToken,
        conversationId: theirs,
        messageId: `mls-flood-${i}`,
        mls: { senderServerUserId: bob.serverUserId, text: "x" },
      });
      answers.push(dave.received("report:submitted").length ? "ok" : ((errors(dave)[0] as { error?: string })?.error ?? "?"));
    }
    assert.ok(answers.includes("ok"));
    assert.equal(answers.at(-1), "rate_limited");
  });
});
