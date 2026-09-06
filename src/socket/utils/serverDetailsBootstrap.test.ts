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
 * The first join on a brand-new server (GRYT-997).
 *
 * A server with no channels yet creates them lazily, inside the same
 * `sendServerDetails` that is about to list them. The permission layer caches
 * the channel list for fifteen seconds, so anything that asked a permission
 * question a moment earlier has cached "there are no channels" — and the owner,
 * who is allowed everything, was handed the empty set of everything.
 *
 * What that looked like: joining a fresh server and landing on a sidebar with
 * nothing in it, which fixed itself on a reload once the cache expired.
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

    // The part that made this a bug rather than a theory: somebody asks a
    // permission question while the channel table is still empty, which is what
    // fills the cache. On a real join plenty of things do.
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
