import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { pluginMessages } from "../../plugins";
import {
  MAX_PAYLOAD_BYTES,
  PLUGIN_MESSAGE_EVENT,
  type IncomingPluginMessage,
} from "../../plugins/messaging";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import { registerPluginHandlers } from "./plugins";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Everything that must be refused before a plugin sees anything, and that who
 * sent it and which plugin it is for come from the connection, not the payload.
 */

const HOST = "plugin-messages.test:5001";

let dir: string;
let token: string;
let serverUserId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-plugin-messages-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  const member = await upsertUser("account-member", "Sivert");
  serverUserId = member.server_user_id;
  token = generateAccessToken({
    grytUserId: "account-member",
    serverUserId,
    nickname: "Sivert",
    serverHost: HOST,
    tokenVersion: 0,
  });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const received: IncomingPluginMessage[] = [];

beforeEach(() => {
  resetRateLimits();
  received.length = 0;
  /* The bus is the process-wide one the server uses, so a plugin id has to be
     fresh per case or a previous case's subscription answers. */
  pluginMessages().remove("presence");
});

function listen(pluginId = "presence", topic = "presence") {
  pluginMessages().subscribe(pluginId, topic, (m) => void received.push(m));
}

function context(): { ctx: HandlerContext; emitted: { event: string; payload: unknown }[] } {
  const emitted: { event: string; payload: unknown }[] = [];
  const clientsInfo: Clients = {
    "socket-under-test": { serverUserId, nickname: "Sivert" } as Clients[string],
  };
  const socket = {
    id: "socket-under-test",
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    join() {},
    leave() {},
    to: () => ({ emit() {} }),
  };
  const ctx = {
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
    socket,
    clientId: "socket-under-test",
    serverId: "plugin-messages-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return { ctx, emitted };
}

const send = async (payload: Record<string, unknown>) => {
  const { ctx, emitted } = context();
  const handlers: EventHandlerMap = registerPluginHandlers(ctx);
  await handlers[PLUGIN_MESSAGE_EVENT](payload);
  return emitted;
};

describe("a message from a client plugin", () => {
  it("reaches the server plugin with the same id", async () => {
    listen();

    await send({ accessToken: token, pluginId: "presence", topic: "presence", data: { playing: "Doom" } });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0].data, { playing: "Doom" });
    assert.equal(received[0].topic, "presence");
  });

  /* From the connection, never the payload, or a member can claim to be somebody
     else to a plugin that acts on who sent something. */
  it("says who sent it, from the connection", async () => {
    listen();

    await send({
      accessToken: token,
      pluginId: "presence",
      topic: "presence",
      data: {},
      userId: "user_somebody_else",
      nickname: "Somebody Else",
    });

    assert.equal(received[0].userId, serverUserId);
    assert.equal(received[0].nickname, "Sivert");
  });
});

describe("a message nobody should see", () => {
  it("is refused without a token", async () => {
    listen();

    await send({ pluginId: "presence", topic: "presence", data: {} });

    assert.equal(received.length, 0);
  });

  it("is refused with a token that is not one", async () => {
    listen();

    await send({ accessToken: "not.a.token", pluginId: "presence", topic: "presence", data: {} });

    assert.equal(received.length, 0);
  });

  /* Before the rate limit is charged: a client running a plugin this server does
     not is not misbehaving, and it sends on every change forever. */
  it("is dropped quietly when no plugin is listening", async () => {
    const emitted = await send({
      accessToken: token,
      pluginId: "nobody-runs-this",
      topic: "presence",
      data: {},
    });

    assert.equal(received.length, 0);
    assert.deepEqual(emitted, [], "a client was told off for running a plugin the server does not");
  });

  /* Quiet even when malformed, or a client is told off about its topic in a
     conversation this server was never part of. */
  it("is dropped quietly even when it is malformed", async () => {
    const emitted = await send({
      accessToken: token,
      pluginId: "nobody-runs-this",
      topic: "not a topic",
      data: "x".repeat(MAX_PAYLOAD_BYTES + 1),
    });

    assert.equal(received.length, 0);
    assert.deepEqual(emitted, [], "a plugin the server does not run got a complaint about its topic");
  });

  it("does not reach a plugin listening on a different topic", async () => {
    listen("presence", "score");

    await send({ accessToken: token, pluginId: "presence", topic: "presence", data: {} });

    assert.equal(received.length, 0);
  });
});

describe("a message that is malformed", () => {
  it("is refused and says why, for a topic that is not one", async () => {
    listen();

    const emitted = await send({
      accessToken: token,
      pluginId: "presence",
      topic: "not a topic",
      data: {},
    });

    assert.equal(received.length, 0);
    assert.equal(emitted[0]?.event, "plugin:error");
    assert.equal((emitted[0]?.payload as { error: string }).error, "invalid_topic");
  });

  it("is refused for a payload over the cap", async () => {
    listen();

    const emitted = await send({
      accessToken: token,
      pluginId: "presence",
      topic: "presence",
      data: "x".repeat(MAX_PAYLOAD_BYTES + 1),
    });

    assert.equal(received.length, 0);
    assert.equal((emitted[0]?.payload as { error: string }).error, "invalid_payload");
  });

  it("is refused for a plugin id that is missing or blank", async () => {
    listen();

    for (const pluginId of [undefined, "", "   ", 42, {}]) {
      await send({ accessToken: token, pluginId, topic: "presence", data: {} });
    }

    assert.equal(received.length, 0);
  });
});

/* A plugin channel must not become an unmetered pipe just because the member on
   the other end joined. */
describe("a client that will not stop", () => {
  it("is cut off, and told", async () => {
    listen();

    let refused: { event: string; payload: unknown }[] = [];
    for (let i = 0; i < 60; i++) {
      const emitted = await send({
        accessToken: token,
        pluginId: "presence",
        topic: "presence",
        data: { i },
      });
      if (emitted.length > 0) refused = emitted;
    }

    assert.ok(received.length < 60, `${received.length} of 60 got through`);
    assert.ok(received.length > 0, "the limit refused everything, including the first");
    assert.equal((refused[0]?.payload as { error: string })?.error, "rate_limited");
  });
});
