import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { ensureDefaultChannels } from "../../db/sqlite/channels";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { setUserModerationState, upsertUser } from "../../db/sqlite/users";
import { generateAccessToken } from "../../utils/jwt";
import type { Clients } from "../../types";
import { registerChatHandlers } from "./chat";
import { registerTypingHandlers } from "./typing";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * A mute has to cover text, not only voice (GRYT-917).
 *
 * Driven through the handlers rather than through `textMuteFor`, because the
 * bug was never in the deciding — `effectiveModerationState` has been right the
 * whole time and the member list has been drawing it. The bug was that nothing
 * on the way to a message asked. A test of the helper would have passed against
 * the broken build.
 *
 * The same harness `permissionGates.test.ts` uses, and for the same reason:
 * `requireAuth` wants a token and a `host` header, and what is under test is
 * the decision rather than the transport.
 */

const HOST = "mute.test:5001";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-mute-"));
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
  payload: unknown;
}

function makeContext(): { ctx: HandlerContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const clientId = "socket-under-test";

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
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
    serverId: "mute-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { ctx, emitted };
}

function handlers(ctx: HandlerContext): EventHandlerMap {
  return { ...registerChatHandlers(ctx), ...registerTypingHandlers(ctx) };
}

let seq = 0;
async function member(mute?: { until: Date | null }): Promise<{
  accessToken: string;
  serverUserId: string;
}> {
  seq += 1;
  const grytUserId = `account-mute-${seq}`;
  const user = await upsertUser(grytUserId, `Muted ${seq}`);
  await setServerRole(user.server_user_id, "talker");

  if (mute) {
    await setUserModerationState(user.server_user_id, {
      muted: true,
      mutedUntil: mute.until,
    });
  }

  return {
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname: `Muted ${seq}`,
      serverHost: HOST,
      tokenVersion: 0,
    }),
    serverUserId: user.server_user_id,
  };
}

/** The refusals this change adds, and nothing else. */
function muteRefusals(emitted: Emitted[]) {
  return emitted
    .map((e) => e.payload as { error?: string; expiresAt?: string | null })
    .filter((p) => p && typeof p === "object" && p.error === "muted");
}

describe("a mute stops text, not only voice", () => {
  it("refuses a send from an indefinitely muted member", async () => {
    const { ctx, emitted } = makeContext();
    const who = await member({ until: null });
    await handlers(ctx)["chat:send"]({
      conversationId: "general",
      accessToken: who.accessToken,
      text: "still here",
    });

    const refused = muteRefusals(emitted);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].expiresAt, null);
  });

  it("refuses a send from a member on a timeout, and says when it lifts", async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const { ctx, emitted } = makeContext();
    const who = await member({ until });
    await handlers(ctx)["chat:send"]({
      conversationId: "general",
      accessToken: who.accessToken,
      text: "an hour to go",
    });

    const refused = muteRefusals(emitted);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].expiresAt, until.toISOString());
  });

  it("lets a member whose timeout has lapsed talk again", async () => {
    // The row still says muted. `effectiveModerationState` is what makes the
    // expiry mean anything, and nothing sweeps the column, so a mute that is
    // only lifted by a background job would still be a mute here.
    const { ctx, emitted } = makeContext();
    const who = await member({ until: new Date(Date.now() - 1000) });
    await handlers(ctx)["chat:send"]({
      conversationId: "general",
      accessToken: who.accessToken,
      text: "time served",
    });

    assert.deepEqual(muteRefusals(emitted), []);
  });

  it("does not refuse a member who is not muted", async () => {
    const { ctx, emitted } = makeContext();
    const who = await member();
    await handlers(ctx)["chat:send"]({
      conversationId: "general",
      accessToken: who.accessToken,
      text: "hello",
    });

    assert.deepEqual(muteRefusals(emitted), []);
  });

  it("refuses an edit, which is the other way to put new text in a channel", async () => {
    const { ctx, emitted } = makeContext();
    const who = await member({ until: null });
    await handlers(ctx)["chat:edit"]({
      conversationId: "general",
      messageId: "m1",
      text: "edited into something else",
      accessToken: who.accessToken,
    });

    assert.equal(muteRefusals(emitted).length, 1);
  });

  it("says nothing to the room about a muted member typing", async () => {
    // Paired with the unmuted case deliberately. The audience is everybody in
    // `clientsInfo` except the typist, so a test with one client in it emits
    // nothing whatever the mute says — which is a test that passes against the
    // broken build. The first half is what proves the harness reaches the emit.
    const heard = async (mute?: { until: Date | null }) => {
      const { ctx, emitted } = makeContext();
      const who = await member(mute);
      ctx.clientsInfo[ctx.clientId] = { serverUserId: who.serverUserId } as Clients[string];
      ctx.clientsInfo["listener"] = { serverUserId: "someone-else" } as Clients[string];
      (ctx.io.sockets.sockets as Map<string, unknown>).set("listener", {
        emit: (event: string, payload?: unknown) => emitted.push({ event, payload }),
      });

      await handlers(ctx)["chat:typing"]({ conversationId: "general" });
      return emitted.filter((e) => e.event === "chat:typing").length;
    };

    assert.equal(await heard(), 1, "an unmuted member's typing reaches the room");
    assert.equal(await heard({ until: null }), 0, "a muted member's does not");
  });
});
