import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { registerMemberHandlers } from "./members";
import type { HandlerContext } from "./types";

/**
 * The Rich Presence card rides on the status line. Driven through the handler,
 * so the pairing of line and card is what gets checked.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-presence-card-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await createRoleDefinition("status-setter", {
    name: "Status setter",
    rank: 50,
    permissions: ["set_activity"],
  });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

interface Emitted {
  event: string;
  payload: { error?: string; retryAfterMs?: number; permission?: string };
}

function makeContext() {
  const emitted: Emitted[] = [];
  const clientId = "card-holder";

  const ctx = {
    io: {
      to: () => ({ emit: () => {} }),
      emit: () => {},
      sockets: { sockets: new Map() },
    },
    socket: {
      id: clientId,
      handshake: { headers: { host: "presence-card.test:5001" }, address: "127.0.0.1" },
      emit: (event: string, payload: Emitted["payload"]) => emitted.push({ event, payload }),
    },
    clientId,
    serverId: "presence-card-test",
    clientsInfo: {} as Clients,
    sfuClient: null,
    getClientIp: () => "127.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { ctx, emitted };
}

// One user per case, because the limiter is keyed on who is calling and a
// second case would start out already banned.
let seq = 0;
async function seat(ctx: HandlerContext, permitted: boolean) {
  seq += 1;
  const user = await upsertUser(`account-card-${seq}`, `Player ${seq}`);
  if (permitted) await setServerRole(user.server_user_id, "status-setter");
  ctx.clientsInfo[ctx.clientId] = { serverUserId: user.server_user_id } as Clients[string];
  return user.server_user_id;
}

describe("a game's card", () => {
  it("is stored beside the line, checked", async () => {
    const { ctx } = makeContext();
    await seat(ctx, true);
    const handlers = registerMemberHandlers(ctx);

    await handlers["presence:activity"]({
      activity: "Playing Factorio",
      rich: { name: "Factorio", state: "Nauvis", buttons: [{ label: "x", url: "javascript:alert(1)" }] },
    });

    const info = ctx.clientsInfo[ctx.clientId];
    assert.equal(info.activity, "Playing Factorio");
    assert.deepEqual(info.richActivity, { type: "playing", name: "Factorio", state: "Nauvis" });
  });

  it("gives a line of its own name when the client sent none", async () => {
    const { ctx } = makeContext();
    await seat(ctx, true);
    const handlers = registerMemberHandlers(ctx);

    await handlers["presence:activity"]({ rich: { name: "Factorio" } });

    assert.equal(ctx.clientsInfo[ctx.clientId].activity, "Factorio");
  });

  it("goes with the line when it is cleared", async () => {
    const { ctx } = makeContext();
    await seat(ctx, true);
    const handlers = registerMemberHandlers(ctx);

    await handlers["presence:activity"]({ activity: "Playing Factorio", rich: { name: "Factorio" } });
    await handlers["presence:activity"]({ activity: "", rich: { name: "Factorio" } });

    assert.equal(ctx.clientsInfo[ctx.clientId].activity, undefined);
    assert.equal(ctx.clientsInfo[ctx.clientId].richActivity, undefined);
  });

  it("is dropped when an older client sends only the line", async () => {
    const { ctx } = makeContext();
    await seat(ctx, true);
    const handlers = registerMemberHandlers(ctx);

    await handlers["presence:activity"]({ activity: "Factorio", rich: { name: "Factorio" } });
    await handlers["presence:activity"]({ activity: "Factorio" });

    assert.equal(ctx.clientsInfo[ctx.clientId].richActivity, undefined);
  });

  it("counts a new round as a change, so it is sent and rate limited", async () => {
    const { ctx, emitted } = makeContext();
    await seat(ctx, true);
    const handlers = registerMemberHandlers(ctx);

    for (let i = 0; i < 11; i++) {
      await handlers["presence:activity"]({ activity: "Factorio", rich: { name: "Factorio", state: `Wave ${i}` } });
    }

    const refused = emitted.filter((e) => e.event === "server:error" && e.payload?.error === "rate_limited");
    assert.equal(refused.length, 1);
    assert.equal(ctx.clientsInfo[ctx.clientId].richActivity?.state, "Wave 9");
  });
});
