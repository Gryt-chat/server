import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { ensureDefaultChannels } from "../../db/sqlite/channels";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { registerTypingHandlers } from "./typing";
import type { HandlerContext } from "./types";

/**
 * A reply in a thread is not somebody typing in the channel. Through the handler
 * because the timer is the interesting part, and the handler owns it.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-typing-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await ensureDefaultChannels();
  await createRoleDefinition("talker", {
    name: "Talker",
    rank: 50,
    permissions: ["send_messages", "read_messages"],
  });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

interface Emitted {
  to: string;
  event: string;
  payload: { conversationId?: string; threadId?: string | null };
}

/** The typist's own socket, plus one listener to emit at. */
function makeContext() {
  const emitted: Emitted[] = [];
  const clientId = "typist";
  const sockets = new Map<string, unknown>([
    ["listener", {
      emit: (event: string, payload: Emitted["payload"]) =>
        emitted.push({ to: "listener", event, payload }),
    }],
  ]);

  const ctx = {
    io: { sockets: { sockets } },
    socket: { id: clientId, handshake: { headers: { host: "typing.test:5001" }, address: "127.0.0.1" } },
    clientId,
    serverId: "typing-test",
    clientsInfo: {} as Clients,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { ctx, emitted };
}

let seq = 0;
async function seat(ctx: HandlerContext) {
  seq += 1;
  const user = await upsertUser(`account-typing-${seq}`, `Typist ${seq}`);
  await setServerRole(user.server_user_id, "talker");
  ctx.clientsInfo[ctx.clientId] = { serverUserId: user.server_user_id } as Clients[string];
  ctx.clientsInfo["listener"] = { serverUserId: `listener-${seq}` } as Clients[string];
  return user.server_user_id;
}

describe("typing carries the thread it is happening in", () => {
  it("sends the thread back out, and null for the channel itself", async () => {
    const { ctx, emitted } = makeContext();
    await seat(ctx);
    const handlers = registerTypingHandlers(ctx);

    await handlers["chat:typing"]({ conversationId: "general", threadId: "thread-7" });
    await handlers["chat:typing"]({ conversationId: "general" });

    const threads = emitted.filter((e) => e.event === "chat:typing").map((e) => e.payload.threadId);
    assert.deepEqual(threads, ["thread-7", null]);
  });

  it("stops the thread without stopping the channel", async () => {
    // Keyed by person and conversation alone, the two shared a timer: starting
    // in the thread cancelled the channel's stop.
    const { ctx, emitted } = makeContext();
    await seat(ctx);
    const handlers = registerTypingHandlers(ctx);

    await handlers["chat:typing"]({ conversationId: "general" });
    await handlers["chat:typing"]({ conversationId: "general", threadId: "thread-7" });
    await handlers["chat:stop_typing"]({ conversationId: "general", threadId: "thread-7" });

    const stops = emitted
      .filter((e) => e.event === "chat:stop_typing")
      .map((e) => e.payload.threadId);
    assert.deepEqual(stops, ["thread-7"], "the channel was stopped along with the thread");
  });
});
