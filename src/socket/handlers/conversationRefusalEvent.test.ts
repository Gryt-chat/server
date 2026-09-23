import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { upsertServerChannel } from "../../db/sqlite/channels";
import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { refreshClientPermissions } from "../utils/standing";
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/* A refused conversation comes back on the event the rest of the handler uses.
   The thread panel sat on "Loading…" when it arrived as chat:error. */

const HOST = "refusal.test:5001";
const CHANNEL = "chan-general";
const MISSING = "chan-there-is-no-such-channel";

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let handlers: EventHandlerMap;
let accessToken: string;
let received: (event: string) => unknown[];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-refusal-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({ channelId: CHANNEL, name: "general", type: "text" });
  const alice = await upsertUser("account-alice", "Alice");
  await setServerRole(alice.server_user_id, "owner");

  const clientId = "socket-1";
  const emitted: { event: string; payload?: unknown }[] = [];
  const record = { emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; } };
  sockets.set(clientId, record);
  const socket = { id: clientId, handshake: { headers: { host: HOST }, address: "127.0.0.1" }, emit: record.emit, join() {}, leave() {}, to: () => ({ emit() {} }) };
  clientsInfo[clientId] = { serverUserId: alice.server_user_id, grytUserId: "account-alice", nickname: "Alice" } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);
  const ctx = { io: { sockets: { sockets } }, socket, clientId, serverId: "refusal-test", clientsInfo, sfuClient: null, getClientIp: () => "10.0.0.1", clientAddressIsOwn: () => true } as unknown as HandlerContext;
  handlers = registerChatHandlers(ctx);
  accessToken = generateAccessToken({ grytUserId: "account-alice", serverUserId: alice.server_user_id, nickname: "Alice", serverHost: HOST, tokenVersion: 0 });
  received = (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload);
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the file */ }
});

describe("a conversation the caller cannot reach", () => {
  it("refuses thread:fetch on thread:error", async () => {
    await handlers["thread:fetch"]({ conversationId: MISSING, threadId: "thread-1" });
    assert.deepEqual(received("chat:error"), [], "the panel never sees chat:error");
    const errors = received("thread:error") as { error?: string }[];
    assert.equal(errors.at(-1)?.error, "not_found");
  });

  it("refuses thread:create on thread:error", async () => {
    await handlers["thread:create"]({ conversationId: MISSING, rootMessageId: "msg-1", accessToken });
    assert.deepEqual(received("chat:error"), []);
    assert.equal((received("thread:error") as { error?: string }[]).at(-1)?.error, "not_found");
  });

  it("refuses forum:topics on forum:error", async () => {
    await handlers["forum:topics"]({ conversationId: MISSING });
    assert.deepEqual(received("chat:error"), []);
    assert.equal((received("forum:error") as { error?: string }[]).at(-1)?.error, "not_found");
  });

  it("still answers a channel the caller can reach", async () => {
    await handlers["thread:fetch"]({ conversationId: CHANNEL, threadId: "thread-nope" });
    const errors = received("thread:error") as { error?: string }[];
    assert.equal(errors.at(-1)?.error, "thread_not_found", "past the access check and on to the thread");
  });
});
