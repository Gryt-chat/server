import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { upsertServerChannel } from "../../db/sqlite/channels";
import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { listThreadsByConversation } from "../../db/sqlite/threads";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Creating a topic makes a root message and a titled thread together, and a
 * reply from a second person moves the participant count.
 */

const HOST = "forum.test:5001";
const FORUM = "chan-support";

interface Party {
  serverUserId: string;
  accessToken: string;
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
}

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let alice: Party;
let bob: Party;

function makeParty(seq: number, grytUserId: string, nickname: string, serverUserId: string): Party {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  const record = { emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; } };
  sockets.set(clientId, record);
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: record.emit,
    join() {}, leave() {}, to: () => ({ emit() {} }),
  };
  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];
  const ctx = {
    io: { sockets: { sockets } }, socket, clientId, serverId: "forum-test",
    clientsInfo, sfuClient: null, getClientIp: () => `10.0.0.${seq}`, clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return {
    serverUserId,
    accessToken: generateAccessToken({ grytUserId, serverUserId, nickname, serverHost: HOST, tokenVersion: 0 }),
    handlers: registerChatHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-forum-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({ channelId: FORUM, name: "support", type: "text", layout: "forum" });
  const a = await upsertUser("account-alice", "Alice");
  const b = await upsertUser("account-bob", "Bob");
  await setServerRole(a.server_user_id, "owner");
  await setServerRole(b.server_user_id, "owner");
  alice = makeParty(1, "account-alice", "Alice", a.server_user_id);
  bob = makeParty(2, "account-bob", "Bob", b.server_user_id);
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps the file open */ }
});

interface TopicSummary {
  thread_id: string;
  root_message_id: string;
  title: string | null;
  reply_count: number;
  participant_count: number;
  preview: string | null;
  creator_nickname: string | null;
}

describe("forum topics", () => {
  let threadId: string;

  it("creates a topic as one root message plus a titled thread", async () => {
    await alice.handlers["forum:topic:create"]({
      conversationId: FORUM,
      title: "Voice drops after sleep",
      text: "After my laptop wakes, voice stops working.",
      accessToken: alice.accessToken,
    });

    assert.deepEqual(alice.received("forum:error"), [], "topic creation was refused");
    const created = alice.received("forum:topic:created").at(-1) as (TopicSummary & { root?: { text?: string } }) | undefined;
    assert.ok(created?.thread_id, "no topic came back");
    assert.equal(created.title, "Voice drops after sleep");
    threadId = created.thread_id;

    const threads = await listThreadsByConversation(FORUM);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].root_message_id, created.root_message_id);
  });

  it("lists the topic with its preview, author and counts", async () => {
    await bob.handlers["forum:topics"]({ conversationId: FORUM });
    const list = bob.received("forum:topics:list").at(-1) as { topics: TopicSummary[] };
    assert.equal(list.topics.length, 1);
    const t = list.topics[0];
    assert.equal(t.title, "Voice drops after sleep");
    assert.equal(t.creator_nickname, "Alice");
    assert.equal(t.reply_count, 0);
    assert.equal(t.participant_count, 1, "just the author so far");
    assert.ok(t.preview && t.preview.startsWith("After my laptop wakes"));
  });

  it("counts a second person once they reply", async () => {
    await bob.handlers["chat:send"]({
      conversationId: FORUM,
      threadId,
      text: "Same here on Fedora.",
      accessToken: bob.accessToken,
    });

    await alice.handlers["forum:topics"]({ conversationId: FORUM });
    const list = alice.received("forum:topics:list").at(-1) as { topics: TopicSummary[] };
    const t = list.topics[0];
    assert.equal(t.reply_count, 1, "the reply was not counted");
    assert.equal(t.participant_count, 2, "the replier should now be a participant");
  });

  it("refuses a topic with no title or no body", async () => {
    const before = alice.received("forum:error").length;
    await alice.handlers["forum:topic:create"]({ conversationId: FORUM, title: "   ", text: "x", accessToken: alice.accessToken });
    await alice.handlers["forum:topic:create"]({ conversationId: FORUM, title: "Real title", text: "  ", accessToken: alice.accessToken });
    const errors = alice.received("forum:error").slice(before) as { error?: string }[];
    assert.ok(errors.some((e) => e?.error === "empty_title"));
    assert.ok(errors.some((e) => e?.error === "empty_body"));
  });
});
