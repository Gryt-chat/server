import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { upsertServerChannel } from "../../db/sqlite/channels";
import { initSqlite } from "../../db/sqlite/connection";
import { insertMessage } from "../../db/sqlite/messages";
import { setReadMarker } from "../../db/sqlite/readMarkers";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { refreshClientPermissions } from "../utils/standing";
import { registerReadMarkerHandlers } from "./readMarkers";
import type { EventHandlerMap, HandlerContext } from "./types";

/* The access check is the part worth a handler test: a marker says where somebody got
   to, not that the conversation is still theirs to see. */

const HOST = "read.test:5001";
const CHANNEL = "chan-general";
const GONE = "chan-no-longer-visible";

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let handlers: EventHandlerMap;
let userId: string;
let received: (event: string) => unknown[];
let clientId: string;
let lastMessageId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-readh-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({ channelId: CHANNEL, name: "general", type: "text" });
  const alice = await upsertUser("account-alice", "Alice");
  userId = alice.server_user_id;
  await setServerRole(userId, "owner");

  const first = await insertMessage({
    conversation_id: CHANNEL,
    sender_server_id: "someone-else",
    text: "hello",
    attachments: null,
    reactions: null,
    created_at: new Date("2026-02-01T00:00:00.000Z"),
  });
  lastMessageId = first.message_id;
  await insertMessage({
    conversation_id: CHANNEL,
    sender_server_id: "someone-else",
    text: "and another",
    attachments: null,
    reactions: null,
    created_at: new Date("2026-02-01T00:00:01.000Z"),
  });

  clientId = "socket-1";
  const emitted: { event: string; payload?: unknown }[] = [];
  const record = { emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; } };
  sockets.set(clientId, record);
  const socket = { id: clientId, handshake: { headers: { host: HOST }, address: "127.0.0.1" }, emit: record.emit, join() {}, leave() {}, to: () => ({ emit() {} }) };
  clientsInfo[clientId] = { serverUserId: userId, grytUserId: "account-alice", nickname: "Alice" } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);
  const ctx = { io: { sockets: { sockets } }, socket, clientId, serverId: "read-test", clientsInfo, sfuClient: null, getClientIp: () => "10.0.0.1", clientAddressIsOwn: () => true } as unknown as HandlerContext;
  handlers = registerReadMarkerHandlers(ctx);
  received = (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload);
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the file */ }
});

type Reply = { markers: { conversation_id: string }[]; counts: Record<string, number> };

describe("read markers over the socket", () => {
  it("starts with nothing, and says so", async () => {
    await handlers["read:list"]();
    const reply = received("read:list").at(-1) as Reply;
    assert.deepEqual(reply.markers, []);
    assert.deepEqual(reply.counts, {});
  });

  it("reads up to a message and counts what is past it", async () => {
    await handlers["read:set"]({ conversationId: CHANNEL, messageId: lastMessageId });
    const reply = received("read:list").at(-1) as Reply;
    assert.deepEqual(reply.markers.map((m) => m.conversation_id), [CHANNEL]);
    assert.equal(reply.counts[CHANNEL], 1);
  });

  it("writes nothing for a conversation the caller cannot reach", async () => {
    await handlers["read:set"]({ conversationId: GONE, messageId: lastMessageId });
    const reply = received("read:list").at(-1) as Reply;
    assert.equal(reply.markers.some((m) => m.conversation_id === GONE), false, "a guessed id got a marker");
  });

  it("leaves out a marker for a conversation the caller can no longer reach", async () => {
    /* Straight to the db, which is the state somebody left behind when a channel was
       deleted or a role taken away. The handler has to drop it on the way out. */
    const stored = await insertMessage({
      conversation_id: GONE,
      sender_server_id: "someone-else",
      text: "from before",
      attachments: null,
      reactions: null,
      created_at: new Date("2026-02-01T00:00:00.000Z"),
    });
    assert.equal(await setReadMarker({ serverUserId: userId, conversationId: GONE, messageId: stored.message_id }), true);

    await handlers["read:list"]();
    const reply = received("read:list").at(-1) as Reply;
    assert.equal(reply.markers.some((m) => m.conversation_id === GONE), false, "the marker leaked a channel");
    assert.equal(reply.counts[GONE], undefined, "the count leaked a channel");
  });

  it("counts an unopened channel from joining, and hides one you can't read", async () => {
    const say = (conversation_id: string) => insertMessage({
      conversation_id,
      sender_server_id: "someone-else",
      text: "new",
      attachments: null,
      reactions: null,
      created_at: new Date("2099-01-01T00:00:00.000Z"),
    });
    await upsertServerChannel({ channelId: "chan-open", name: "open", type: "text" });
    await upsertServerChannel({ channelId: "chan-staff", name: "staff", type: "text" });
    await say("chan-open");
    await say("chan-staff");

    await createRoleDefinition("regular", { name: "Regular", rank: 10, permissions: ["read_messages"] });
    const scope = await createPermissionScope({ isTemplate: false });
    await replacePermissionRules(scope, [{ roleId: "regular", permission: "read_messages", effect: "deny" }]);
    await setChannelPermissionScope("chan-staff", scope);
    resetChannelPermissionCache();

    const dana = await upsertUser("account-dana", "Dana");
    await setServerRole(dana.server_user_id, "regular");
    const owner = clientsInfo[clientId].serverUserId;
    clientsInfo[clientId].serverUserId = dana.server_user_id;
    await handlers["read:list"]();
    clientsInfo[clientId].serverUserId = owner;

    const reply = received("read:list").at(-1) as Reply;
    assert.equal(reply.counts["chan-open"], 1);
    assert.equal(reply.counts["chan-staff"], undefined, "the count leaked a private channel");
  });

  it("ignores a client that has not finished signing in", async () => {
    const real = clientsInfo[clientId].serverUserId;
    clientsInfo[clientId].serverUserId = "temp_not-yet";
    const before = received("read:list").length;
    await handlers["read:list"]();
    await handlers["read:set"]({ conversationId: CHANNEL, messageId: lastMessageId });
    assert.equal(received("read:list").length, before, "a temp client got an answer");
    clientsInfo[clientId].serverUserId = real;
  });

  it("wants a conversation", async () => {
    const before = received("read:list").length;
    await handlers["read:set"]({ messageId: lastMessageId });
    await handlers["read:set"](undefined);
    assert.equal(received("read:list").length, before, "a half-filled payload was answered");
  });
});
