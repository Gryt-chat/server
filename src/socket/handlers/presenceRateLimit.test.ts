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
 * A status change is a server-wide broadcast, so the handler has to stop
 * somebody sending them in a loop. Driven through the handler, like typing.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-presence-"));
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
  const clientId = "status-spammer";

  const ctx = {
    io: {
      to: () => ({ emit: () => {} }),
      emit: () => {},
      sockets: { sockets: new Map() },
    },
    socket: {
      id: clientId,
      handshake: { headers: { host: "presence.test:5001" }, address: "127.0.0.1" },
      emit: (event: string, payload: Emitted["payload"]) => emitted.push({ event, payload }),
    },
    clientId,
    serverId: "presence-test",
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
  const user = await upsertUser(`account-presence-${seq}`, `Poser ${seq}`);
  if (permitted) await setServerRole(user.server_user_id, "status-setter");
  ctx.clientsInfo[ctx.clientId] = { serverUserId: user.server_user_id } as Clients[string];
  return user.server_user_id;
}

function limited(emitted: Emitted[]): Emitted[] {
  return emitted.filter((e) => e.event === "server:error" && e.payload?.error === "rate_limited");
}

describe("a status cannot be changed in a loop", () => {
  it("takes ten in a row and refuses the eleventh", async () => {
    const { ctx, emitted } = makeContext();
    await seat(ctx, true);
    const handlers = registerMemberHandlers(ctx);

    // Each one different, or the handler drops it as unchanged before the
    // limiter ever sees it.
    for (let i = 0; i < 10; i++) {
      await handlers["presence:activity"]({ activity: `status ${i}` });
    }
    assert.equal(limited(emitted).length, 0, "a normal run was refused");
    assert.equal(ctx.clientsInfo[ctx.clientId].activity, "status 9");

    await handlers["presence:activity"]({ activity: "one too many" });

    const refusals = limited(emitted);
    assert.equal(refusals.length, 1);
    assert.ok((refusals[0].payload.retryAfterMs ?? 0) > 0, "no retryAfterMs to wait for");
    assert.equal(
      ctx.clientsInfo[ctx.clientId].activity,
      "status 9",
      "the refused status was set anyway",
    );
  });

  it("keeps refusing after the ban lands, so the loop gets nowhere", async () => {
    const { ctx, emitted } = makeContext();
    await seat(ctx, true);
    const handlers = registerMemberHandlers(ctx);

    for (let i = 0; i < 14; i++) {
      await handlers["presence:activity"]({ activity: `status ${i}` });
    }

    assert.equal(limited(emitted).length, 4);
    assert.equal(ctx.clientsInfo[ctx.clientId].activity, "status 9");
  });

  it("counts a caller who has no permission to set one", async () => {
    const { ctx, emitted } = makeContext();
    await seat(ctx, false);
    const handlers = registerMemberHandlers(ctx);

    for (let i = 0; i < 11; i++) {
      await handlers["presence:activity"]({ activity: `status ${i}` });
    }

    assert.equal(limited(emitted).length, 1, "refused calls were free to repeat");
  });
});
