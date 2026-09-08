import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache, visibleChannelIds } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { sendServerDetails } from "./server";

/**
 * A new server creates its channels inside the `sendServerDetails` that lists
 * them, and a cached empty list left the first join on an empty sidebar.
 */

const HOST = "bootstrap.test:5001";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-bootstrap-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  delete process.env.DATA_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file open past the run.
  }
});

describe("the first join on a server with no channels yet", () => {
  it("lists the channels it just created, not the empty set it had cached", async () => {
    const owner = await upsertUser("account-owner", "Owner");
    await setServerRole(owner.server_user_id, "owner");

    // A permission question asked while the table is still empty is what fills
    // the cache, and on a real join plenty of things ask one.
    resetChannelPermissionCache();
    const beforeSeeding = await visibleChannelIds(owner.server_user_id, "account-owner");
    assert.equal(beforeSeeding.size, 0, "nothing exists yet, so nothing is visible yet");

    const emitted: { event: string; payload?: unknown }[] = [];
    const clientId = "sock-owner";
    const socket = {
      id: clientId,
      handshake: { headers: { host: HOST }, address: "127.0.0.1" },
      rooms: new Set<string>(["verifiedClients"]),
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
    const clientsInfo: Clients = {
      [clientId]: {
        serverUserId: owner.server_user_id,
        grytUserId: "account-owner",
        nickname: "Owner",
      } as Clients[string],
    };

    await sendServerDetails(socket as never, clientsInfo, "bootstrap-test");

    const details = emitted.find((e) => e.event === "server:details")?.payload as
      | { channels?: { id: string }[]; sidebar_items?: unknown[]; error?: string }
      | undefined;

    assert.ok(details, "no server:details went out");
    assert.equal(details.error, undefined, "the owner was refused");
    assert.ok(
      (details.channels?.length ?? 0) > 0,
      "the seeded channels were filtered out by a cache that predates them",
    );
    assert.ok((details.sidebar_items?.length ?? 0) > 0, "the sidebar came back empty");
  });
});
