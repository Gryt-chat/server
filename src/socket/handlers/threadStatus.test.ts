import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { upsertServerChannel } from "../../db/sqlite/channels";
import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { getThread } from "../../db/sqlite/threads";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Marking a topic solved / open / closed, and who may. The author can settle
 * their own; a moderator can settle anyone's; an ordinary member can settle
 * nobody's.
 */

const HOST = "status.test:5001";
const FORUM = "chan-support";

interface Party { serverUserId: string; accessToken: string; handlers: EventHandlerMap; received: (e: string) => unknown[]; }

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let alice: Party; let bob: Party; let carol: Party;

function makeParty(seq: number, grytUserId: string, nickname: string, serverUserId: string): Party {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  const record = { emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; } };
  sockets.set(clientId, record);
  const socket = { id: clientId, handshake: { headers: { host: HOST }, address: "127.0.0.1" }, emit: record.emit, join() {}, leave() {}, to: () => ({ emit() {} }) };
  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];
  const ctx = { io: { sockets: { sockets } }, socket, clientId, serverId: "status-test", clientsInfo, sfuClient: null, getClientIp: () => `10.0.0.${seq}`, clientAddressIsOwn: () => true } as unknown as HandlerContext;
  return {
    serverUserId,
    accessToken: generateAccessToken({ grytUserId, serverUserId, nickname, serverHost: HOST, tokenVersion: 0 }),
    handlers: registerChatHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

let threadId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-status-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({ channelId: FORUM, name: "support", type: "text", layout: "forum" });
  const a = await upsertUser("account-alice", "Alice");
  const b = await upsertUser("account-bob", "Bob");
  const c = await upsertUser("account-carol", "Carol");
  await setServerRole(a.server_user_id, "owner");
  await setServerRole(b.server_user_id, "owner");
  await setServerRole(c.server_user_id, "member");
  alice = makeParty(1, "account-alice", "Alice", a.server_user_id);
  bob = makeParty(2, "account-bob", "Bob", b.server_user_id);
  carol = makeParty(3, "account-carol", "Carol", c.server_user_id);

  await alice.handlers["forum:topic:create"]({ conversationId: FORUM, title: "Voice drops after sleep", text: "It stops after waking.", accessToken: alice.accessToken });
  const created = alice.received("forum:topic:created").at(-1) as { thread_id: string };
  threadId = created.thread_id;
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the file */ }
});

describe("marking a topic solved", () => {
  it("lets the author mark their own topic solved", async () => {
    await alice.handlers["thread:status:set"]({ conversationId: FORUM, threadId, status: "solved", accessToken: alice.accessToken });
    assert.deepEqual(alice.received("thread:error"), [], "the author was refused");
    const upd = alice.received("thread:updated").at(-1) as { status: string };
    assert.equal(upd.status, "solved");
    assert.equal((await getThread(threadId))?.status, "solved");
  });

  it("refuses an ordinary member who is not the author", async () => {
    await carol.handlers["thread:status:set"]({ conversationId: FORUM, threadId, status: "closed", accessToken: carol.accessToken });
    const errors = carol.received("thread:error") as { error?: string }[];
    assert.ok(errors.some((e) => e?.error === "forbidden"), "a non-author member should be refused");
    assert.equal((await getThread(threadId))?.status, "solved", "the status must not have changed");
  });

  it("lets a moderator settle a topic they did not start", async () => {
    await bob.handlers["thread:status:set"]({ conversationId: FORUM, threadId, status: "closed", accessToken: bob.accessToken });
    assert.deepEqual(bob.received("thread:error"), [], "the moderator was refused");
    assert.equal((await getThread(threadId))?.status, "closed");
  });

  it("refuses a nonsense status", async () => {
    const before = alice.received("thread:error").length;
    await alice.handlers["thread:status:set"]({ conversationId: FORUM, threadId, status: "wontfix", accessToken: alice.accessToken });
    const errors = alice.received("thread:error").slice(before) as { error?: string }[];
    assert.ok(errors.some((e) => e?.error === "bad_status"));
  });
});
