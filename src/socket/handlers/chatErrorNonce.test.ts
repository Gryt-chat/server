import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { ensureDefaultChannels } from "../../db/sqlite/channels";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { generateAccessToken } from "../../utils/jwt";
import type { Clients } from "../../types";
import { registerChatHandlers } from "./chat";
import type { HandlerContext } from "./types";

/**
 * A refusal carries the nonce of the send it refuses, as a second argument.
 * Without it a burst of refusals could only ever settle the last row. GRYT-1410.
 */

const HOST = "nonce.test:5001";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-nonce-"));
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
  event: string;
  args: unknown[];
}

let ips = 0;

function makeContext(): { ctx: HandlerContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const clientId = `socket-nonce-${++ips}`;
  // Its own address, so the in-memory rate limiter starts empty for each test.
  const ip = `10.0.0.${ips}`;

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
    serverId: "nonce-test",
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
  const grytUserId = `account-nonce-${seq}`;
  const user = await upsertUser(grytUserId, `Sender ${seq}`);
  await setServerRole(user.server_user_id, "talker");
  return generateAccessToken({
    grytUserId,
    serverUserId: user.server_user_id,
    nickname: `Sender ${seq}`,
    serverHost: HOST,
    tokenVersion: 0,
  });
}

const refusals = (emitted: Emitted[]) => emitted.filter((e) => e.event === "chat:error");

describe("chat:error names the send it refuses", () => {
  it("carries the nonce after the payload, which keeps its old shape", async () => {
    const { ctx, emitted } = makeContext();
    const accessToken = await member();
    await registerChatHandlers(ctx)["chat:send"]({
      conversationId: "general",
      accessToken,
      text: "   ",
      nonce: "nonce-empty",
    });

    const [refused] = refusals(emitted);
    assert.ok(refused, JSON.stringify(emitted));
    assert.deepEqual(refused.args, ["Message is empty", { nonce: "nonce-empty" }]);
  });

  it("carries it on a refusal from the access check too", async () => {
    const { ctx, emitted } = makeContext();
    const accessToken = await member();
    await registerChatHandlers(ctx)["chat:send"]({
      conversationId: "no-such-channel",
      accessToken,
      text: "hello",
      nonce: "nonce-nowhere",
    });

    const [refused] = refusals(emitted);
    assert.ok(refused, JSON.stringify(emitted));
    assert.deepEqual(refused.args[1], { nonce: "nonce-nowhere" });
  });

  it("gives each send in a rate-limited burst its own nonce back", async () => {
    const { ctx, emitted } = makeContext();
    const handlers = registerChatHandlers(ctx);
    const sent = Array.from({ length: 24 }, (_, i) => `nonce-burst-${i}`);
    // The payload is refused either way; the rate limit is checked before it.
    await Promise.all(sent.map((nonce) => handlers["chat:send"]({ nonce } as never)));

    const limited = refusals(emitted).filter(
      (e) => (e.args[0] as { error?: string } | null)?.error === "rate_limited",
    );
    assert.ok(limited.length > 0, "a burst of 24 should trip the send limit");
    const named = refusals(emitted).map((e) => (e.args[1] as { nonce?: string } | undefined)?.nonce);
    assert.deepEqual([...named].sort(), [...sent].sort(), "every refusal should name its own send, once");
  });

  it("sends no second argument for a send that carried no nonce", async () => {
    const { ctx, emitted } = makeContext();
    const accessToken = await member();
    await registerChatHandlers(ctx)["chat:send"]({ conversationId: "general", accessToken, text: "" });

    const [refused] = refusals(emitted);
    assert.deepEqual(refused.args, ["Message is empty"]);
  });
});
