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
 * Forum tags: a topic only keeps tag ids the channel actually offers, and only
 * the author or a moderator can change them.
 */

const HOST = "tags.test:5001";
const FORUM = "chan-support";

interface Party { serverUserId: string; accessToken: string; handlers: EventHandlerMap; received: (e: string) => unknown[]; }

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let alice: Party; let carol: Party;

function makeParty(seq: number, grytUserId: string, nickname: string, serverUserId: string): Party {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  const record = { emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; } };
  sockets.set(clientId, record);
  const socket = { id: clientId, handshake: { headers: { host: HOST }, address: "127.0.0.1" }, emit: record.emit, join() {}, leave() {}, to: () => ({ emit() {} }) };
  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];
  const ctx = { io: { sockets: { sockets } }, socket, clientId, serverId: "tags-test", clientsInfo, sfuClient: null, getClientIp: () => `10.0.0.${seq}`, clientAddressIsOwn: () => true } as unknown as HandlerContext;
  return {
    serverUserId,
    accessToken: generateAccessToken({ grytUserId, serverUserId, nickname, serverHost: HOST, tokenVersion: 0 }),
    handlers: registerChatHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

let threadId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-tags-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({
    channelId: FORUM, name: "support", type: "text", layout: "forum",
    forumTags: [{ id: "linux", name: "Linux" }, { id: "voice", name: "Voice" }],
  });
  const a = await upsertUser("account-alice", "Alice");
  const c = await upsertUser("account-carol", "Carol");
  await setServerRole(a.server_user_id, "owner");
  await setServerRole(c.server_user_id, "member");
  alice = makeParty(1, "account-alice", "Alice", a.server_user_id);
  carol = makeParty(2, "account-carol", "Carol", c.server_user_id);
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe("forum tags", () => {
  it("keeps only tags the channel offers when a topic is created", async () => {
    await alice.handlers["forum:topic:create"]({
      conversationId: FORUM, title: "Voice cuts out on Linux", text: "It drops after sleep.",
      tagIds: ["linux", "not-a-real-tag"], accessToken: alice.accessToken,
    });
    const created = alice.received("forum:topic:created").at(-1) as { thread_id: string };
    threadId = created.thread_id;
    assert.deepEqual((await getThread(threadId))?.tags, ["linux"], "the bogus tag should be dropped");
  });

  it("lists the topic with its tags", async () => {
    await alice.handlers["forum:topics"]({ conversationId: FORUM });
    const list = alice.received("forum:topics:list").at(-1) as { topics: { thread_id: string; tags: string[] }[] };
    const t = list.topics.find((x) => x.thread_id === threadId);
    assert.deepEqual(t?.tags, ["linux"]);
  });

  it("lets the author change the tags, dropping unknown ones", async () => {
    await alice.handlers["thread:tags:set"]({ conversationId: FORUM, threadId, tagIds: ["linux", "voice", "ghost"], accessToken: alice.accessToken });
    assert.deepEqual(alice.received("thread:error").filter((e) => e), [], "the author was refused");
    assert.deepEqual((await getThread(threadId))?.tags, ["linux", "voice"]);
  });

  it("refuses an ordinary member who is not the author", async () => {
    await carol.handlers["thread:tags:set"]({ conversationId: FORUM, threadId, tagIds: [], accessToken: carol.accessToken });
    const errors = carol.received("thread:error") as { error?: string }[];
    assert.ok(errors.some((e) => e?.error === "forbidden"));
    assert.deepEqual((await getThread(threadId))?.tags, ["linux", "voice"], "tags must be unchanged");
  });
});
