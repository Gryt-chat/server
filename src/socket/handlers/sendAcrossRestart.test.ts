import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { ensureDefaultChannels } from "../../db/sqlite/channels";
import { listMessages } from "../../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { generateAccessToken } from "../../utils/jwt";
import type { Clients } from "../../types";
import type { HandlerContext } from "./types";

/**
 * A message sent across a server restart goes out once. The client sends it again
 * under the same nonce, and the server has to know it already wrote it. GRYT-1453.
 */

const HOST = "restart.test:5001";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-restart-"));
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

type ChatModule = typeof import("./chat");

/** The handlers as a freshly started server has them: nothing in memory from before. */
function freshServer(): ChatModule {
  delete require.cache[require.resolve("./chat")];
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module is the restart
  return require("./chat") as ChatModule;
}

interface Emitted {
  event: string;
  args: unknown[];
}

let ips = 0;

/** A socket back from a restart that has not restored its session: no clientsInfo entry. */
function unidentifiedSocket(): { ctx: HandlerContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const clientId = `socket-restart-${++ips}`;
  const ip = `10.1.0.${ips}`;
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: ip },
    emit(event: string, ...args: unknown[]) {
      emitted.push({ event, args });
      return true;
    },
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
  };
  const io = {
    to() {
      return { emit() {} };
    },
    emit() {},
    sockets: { sockets: new Map() },
  };
  const clientsInfo: Clients = {};
  const ctx = {
    io,
    socket,
    clientId,
    serverId: "restart-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => ip,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return { ctx, emitted };
}

let seq = 0;
async function member(): Promise<string> {
  seq += 1;
  const grytUserId = `account-restart-${seq}`;
  const user = await upsertUser(grytUserId, `Restarter ${seq}`);
  await setServerRole(user.server_user_id, "talker");
  return generateAccessToken({
    grytUserId,
    serverUserId: user.server_user_id,
    nickname: `Restarter ${seq}`,
    serverHost: HOST,
    tokenVersion: 0,
  });
}

const echoes = (emitted: Emitted[]) =>
  emitted.filter((e) => e.event === "chat:new").map((e) => e.args[0] as { message_id: string; text: string; nonce?: string });

async function rowsSaying(text: string) {
  return (await listMessages("general", 200)).filter((m) => m.text === text);
}

describe("a send across a restart", () => {
  it("echoes a message back to a socket that has not been restored yet", async () => {
    const { ctx, emitted } = unidentifiedSocket();
    const accessToken = await member();
    await freshServer().registerChatHandlers(ctx)["chat:send"]({
      conversationId: "general",
      accessToken,
      text: "sent before the restore",
      nonce: "nonce-unrestored",
    });

    const [echo] = echoes(emitted);
    assert.ok(echo, `no chat:new came back: ${JSON.stringify(emitted)}`);
    assert.equal(echo.nonce, "nonce-unrestored");
    assert.equal(echo.text, "sent before the restore");
  });

  it("writes a resend once, when the server restarted between the two", async () => {
    const accessToken = await member();
    const first = unidentifiedSocket();
    await freshServer().registerChatHandlers(first.ctx)["chat:send"]({
      conversationId: "general",
      accessToken,
      text: "written, then the server died",
      nonce: "nonce-across-restart",
    });

    const second = unidentifiedSocket();
    await freshServer().registerChatHandlers(second.ctx)["chat:send"]({
      conversationId: "general",
      accessToken,
      text: "written, then the server died",
      nonce: "nonce-across-restart",
    });

    const rows = await rowsSaying("written, then the server died");
    assert.equal(rows.length, 1, "the resend should not be a second message");
    const [echo] = echoes(second.emitted);
    assert.ok(echo, "the resend should be answered, or the row never settles");
    assert.equal(echo.nonce, "nonce-across-restart");
    assert.equal(echo.message_id, rows[0].message_id);
  });

  it("writes the same send once when both copies arrive together", async () => {
    const accessToken = await member();
    const { ctx } = unidentifiedSocket();
    const send = freshServer().registerChatHandlers(ctx)["chat:send"];
    const payload = { conversationId: "general", accessToken, text: "sent twice at once", nonce: "nonce-at-once" };
    await Promise.all([send(payload), send({ ...payload })]);

    assert.equal((await rowsSaying("sent twice at once")).length, 1);
  });

  it("keeps two senders' messages apart when their nonces match", async () => {
    const alice = unidentifiedSocket();
    const bob = unidentifiedSocket();
    const handlers = freshServer();
    await handlers.registerChatHandlers(alice.ctx)["chat:send"]({
      conversationId: "general",
      accessToken: await member(),
      text: "alice's words",
      nonce: "nonce-shared",
    });
    await handlers.registerChatHandlers(bob.ctx)["chat:send"]({
      conversationId: "general",
      accessToken: await member(),
      text: "bob's words",
      nonce: "nonce-shared",
    });

    assert.equal((await rowsSaying("bob's words")).length, 1, "bob's message should be written");
    assert.deepEqual(
      echoes(bob.emitted).map((m) => m.text),
      ["bob's words"],
      "bob should get his own message back, never alice's",
    );
  });
});
