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

/**
 * GRYT-1391: chat:fetch's threads[], thread:create's thread:created, and
 * forum:topic:create's thread:created all build a thread summary through the
 * same toThreadSummary now, so they carry the same base fields. forum:topics
 * needs more than a thread record can give it (a participant count, the
 * root's author, a preview), and that is the one place a summary legitimately
 * grows past the shared shape.
 */

const HOST = "shape.test:5001";
const CHANNEL = "chan-general";

interface Party { serverUserId: string; accessToken: string; handlers: EventHandlerMap; received: (e: string) => unknown[]; }

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let alice: Party;

async function makeParty(seq: number, grytUserId: string, nickname: string, serverUserId: string): Promise<Party> {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  const record = { emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; } };
  sockets.set(clientId, record);
  const socket = { id: clientId, handshake: { headers: { host: HOST }, address: "127.0.0.1" }, emit: record.emit, join() {}, leave() {}, to: () => ({ emit() {} }) };
  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);
  const ctx = {
    io: { sockets: { sockets } }, socket, clientId, serverId: "shape-test",
    clientsInfo, sfuClient: null, getClientIp: () => `10.0.1.${seq}`, clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return {
    serverUserId,
    accessToken: generateAccessToken({ grytUserId, serverUserId, nickname, serverHost: HOST, tokenVersion: 0 }),
    handlers: registerChatHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-thread-shape-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({ channelId: CHANNEL, name: "general", type: "text" });
  const a = await upsertUser("account-alice", "Alice");
  await setServerRole(a.server_user_id, "owner");
  alice = await makeParty(1, "account-alice", "Alice", a.server_user_id);
});

after(() => {
  delete process.env.DATA_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the file */ }
});

const BASE_THREAD_FIELDS = [
  "thread_id",
  "conversation_id",
  "root_message_id",
  "title",
  "created_by",
  "status",
  "reply_count",
  "locked",
  "tags",
  "created_at",
  "last_message_at",
].sort();

describe("one thread summary shape everywhere (GRYT-1391)", () => {
  it("thread:create's thread:created carries every base field, tags included", async () => {
    await alice.handlers["chat:send"]({ conversationId: CHANNEL, text: "root for thread:create", accessToken: alice.accessToken });
    const rootMessageId = (alice.received("chat:new").at(-1) as { message_id: string }).message_id;

    await alice.handlers["thread:create"]({ conversationId: CHANNEL, rootMessageId, accessToken: alice.accessToken });
    const created = alice.received("thread:created").at(-1) as Record<string, unknown>;

    assert.deepEqual(Object.keys(created).sort(), BASE_THREAD_FIELDS);
    assert.deepEqual(created.tags, [], "a fresh thread has no tags, but the field is there");
  });

  it("forum:topic:create's thread:created carries the same fields as thread:create's", async () => {
    await alice.handlers["forum:topic:create"]({
      conversationId: CHANNEL,
      title: "A forum topic",
      text: "root for forum:topic:create",
      accessToken: alice.accessToken,
    });
    const created = alice.received("thread:created").at(-1) as Record<string, unknown>;

    assert.deepEqual(Object.keys(created).sort(), BASE_THREAD_FIELDS);
  });

  it("chat:fetch's threads[] carries the same base fields", async () => {
    // chat:fetch's cache only holds messages sent through chat:send, so it is
    // only the thread:create root (the first test) that can show up here —
    // the forum topic's root was inserted straight to the DB.
    await alice.handlers["chat:fetch"]({ conversationId: CHANNEL, limit: 50 });
    const history = alice.received("chat:history").at(-1) as { threads: Record<string, unknown>[] };

    assert.ok(history.threads.length >= 1, "the thread:create thread should be on the page");
    for (const t of history.threads) {
      assert.deepEqual(Object.keys(t).sort(), BASE_THREAD_FIELDS);
    }
  });

  it("forum:topics' topics[] keeps every base field and adds only what a topic row needs", async () => {
    await alice.handlers["forum:topics"]({ conversationId: CHANNEL });
    const list = alice.received("forum:topics:list").at(-1) as { topics: Record<string, unknown>[] };

    assert.ok(list.topics.length >= 2);
    const extra = ["participant_count", "creator_server_id", "creator_nickname", "creator_avatar_file_id", "preview"].sort();
    for (const t of list.topics) {
      const keys = Object.keys(t).sort();
      assert.deepEqual(keys, [...BASE_THREAD_FIELDS, ...extra].sort(), "every base field, plus exactly the forum-only extras");
      assert.equal(t.creator_server_id, t.created_by, "the forum-specific alias and the base field agree");
    }
  });
});
