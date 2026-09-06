import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { registerPluginHandlers } from "../socket/handlers/plugins";
import type { EventHandlerMap, HandlerContext } from "../socket/handlers/types";
import type { Clients } from "../types";
import { generateAccessToken } from "../utils/jwt";
import { resetRateLimits } from "../utils/rateLimiter";
import { initPlugins, PLUGIN_MESSAGE_EVENT } from "./index";
import { setPluginRefs } from "./refs";

/**
 * One message all the way through, in one test (GRYT-939).
 *
 * Every piece of this is covered on its own: the handler parses and refuses,
 * the bus routes, `send` picks who to reach. What none of those cover is
 * whether the pieces are connected — and the failure that would look most like
 * working software is a second bus somewhere in the middle, where every unit
 * test still passes and no plugin ever hears anything.
 *
 * So this loads a real plugin from a real folder through `initPlugins`, hands
 * the socket handler a real signed token, and watches what comes back out at
 * the sockets. The only thing standing in for the real world is socket.io
 * itself, which is somebody else's code doing the one job it has.
 *
 * The plugin under test is the shape the docs describe: hear that somebody is
 * playing something, tell everybody else.
 */

const HOST = "round-trip.test:5001";

let dir: string;
let token: string;
let serverUserId: string;

/** What reached a socket, in order. */
const emitted: { clientId: string; event: string; payload: unknown }[] = [];

const clientsInfo: Clients = {};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-round-trip-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  const member = await upsertUser("account-sender", "Sivert");
  serverUserId = member.server_user_id;
  token = generateAccessToken({
    grytUserId: "account-sender",
    serverUserId,
    nickname: "Sivert",
    serverHost: HOST,
    tokenVersion: 0,
  });

  const other = await upsertUser("account-listener", "Someone Else");

  clientsInfo["socket-sender"] = { serverUserId, nickname: "Sivert" } as Clients[string];
  clientsInfo["socket-listener"] = {
    serverUserId: other.server_user_id,
    nickname: "Someone Else",
  } as Clients[string];
  /* Mid-join, so nothing should reach it. Present because a real server always
     has one of these and the fan-out has to skip it. */
  clientsInfo["socket-joining"] = { serverUserId: "temp_abc" } as Clients[string];

  const io = {
    sockets: {
      sockets: {
        get: (clientId: string) => ({
          emit: (event: string, payload: unknown) =>
            void emitted.push({ clientId, event, payload }),
        }),
      },
    },
  } as never;
  setPluginRefs({ io, serverId: "round-trip-test", clientsInfo, sfuClient: null });

  /*
   * A real plugin, on disk, loaded the way a server loads one. Written as the
   * docs describe the worked pair: hear who is playing something, tell
   * everybody else.
   */
  const folder = join(dir, "plugins", "presence");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      id: "presence",
      name: "Presence",
      version: "1.0.0",
      main: "index.mjs",
      capabilities: ["messaging"],
      public: true,
    }),
  );
  writeFileSync(
    join(folder, "index.mjs"),
    `export function activate(api) {
       api.messaging.on("playing", (m) => {
         api.messaging.send("playing", { who: m.nickname, game: m.data.game });
       });
     }`,
  );

  process.env.GRYT_PLUGINS_DIR = join(dir, "plugins");
  await initPlugins();
  delete process.env.GRYT_PLUGINS_DIR;
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function send(payload: Record<string, unknown>) {
  const socket = {
    id: "socket-sender",
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: () => true,
    join() {},
    leave() {},
    to: () => ({ emit() {} }),
  };
  const ctx = {
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
    socket,
    clientId: "socket-sender",
    serverId: "round-trip-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  const handlers: EventHandlerMap = registerPluginHandlers(ctx);
  return handlers[PLUGIN_MESSAGE_EVENT](payload);
}

describe("a message from one client to everybody else's plugin", () => {
  it("arrives, having been through the server plugin", async () => {
    resetRateLimits();
    emitted.length = 0;

    await send({
      accessToken: token,
      pluginId: "presence",
      topic: "playing",
      data: { game: "Factorio" },
    });

    /* Everybody joined, and only them: the connection still mid-join has no
       member behind it and its id would mean nothing to a plugin. */
    assert.deepEqual(
      emitted.map((e) => e.clientId).sort(),
      ["socket-listener", "socket-sender"],
      "the fan-out reached the wrong sockets",
    );

    assert.deepEqual(emitted[0].payload, {
      pluginId: "presence",
      topic: "playing",
      /* The plugin's own shape, not the one that arrived — proof this went
         through the plugin rather than past it. */
      data: { who: "Sivert", game: "Factorio" },
    });
    assert.equal(emitted[0].event, PLUGIN_MESSAGE_EVENT);
  });

  /*
   * The failure this file exists for. Every unit test in this folder passes
   * against a bus nothing is connected to, so the thing worth asserting is that
   * the plugin the loader started is the plugin the handler reaches.
   */
  it("goes nowhere for a plugin this server does not run", async () => {
    resetRateLimits();
    emitted.length = 0;

    await send({
      accessToken: token,
      pluginId: "scoreboard",
      topic: "playing",
      data: { game: "Factorio" },
    });

    assert.deepEqual(emitted, []);
  });

  it("goes nowhere on a topic the plugin did not ask for", async () => {
    resetRateLimits();
    emitted.length = 0;

    await send({
      accessToken: token,
      pluginId: "presence",
      topic: "score",
      data: {},
    });

    assert.deepEqual(emitted, []);
  });

  /* The nickname reaching the plugin came from the connection, not the payload,
     and this is where that matters: it is what other members end up seeing. */
  it("carries the sender the server knows, not the one they claimed", async () => {
    resetRateLimits();
    emitted.length = 0;

    await send({
      accessToken: token,
      pluginId: "presence",
      topic: "playing",
      data: { game: "Doom" },
      nickname: "Somebody Else",
      userId: "user_somebody_else",
    });

    assert.deepEqual((emitted[0].payload as { data: unknown }).data, {
      who: "Sivert",
      game: "Doom",
    });
  });
});
