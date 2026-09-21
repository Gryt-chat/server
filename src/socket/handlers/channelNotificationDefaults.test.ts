import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { channelNotificationLevel, getServerChannel, upsertServerChannel, upsertServerSidebarItem } from "../../db/sqlite/channels";
import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { sendServerDetails } from "../utils/server";

/**
 * A channel carries the level a member hears it at until they pick their own.
 * Nothing stored follows the kind: automated is quiet, everything else is loud.
 */

const HOST = "notification-defaults.test:5001";

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-notif-defaults-"));
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

async function detailsFor(grytUserId: string, serverUserId: string) {
  const emitted: { event: string; payload?: unknown }[] = [];
  const clientId = `sock-${grytUserId}`;
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
    [clientId]: { serverUserId, grytUserId, nickname: "Owner" } as Clients[string],
  };
  await sendServerDetails(socket as never, clientsInfo, "notif-defaults-test");
  const details = emitted.find((e) => e.event === "server:details")?.payload as
    | { channels?: { id: string; automated?: boolean; defaultNotificationLevel?: string }[]; sidebar_items?: { kind: string }[]; error?: string }
    | undefined;
  assert.ok(details, "no server:details went out");
  assert.equal(details.error, undefined, "the owner was refused");
  return details;
}

describe("what a channel stores", () => {
  it("follows the kind when nothing is stored", async () => {
    await upsertServerChannel({ channelId: "plain", name: "general", type: "text" });
    await upsertServerChannel({ channelId: "feed", name: "git-activity", type: "text", automated: true });
    const plain = await getServerChannel("plain");
    const feed = await getServerChannel("feed");
    assert.equal(plain?.default_notification, null);
    assert.equal(channelNotificationLevel(plain!), "all");
    assert.equal(feed?.default_notification, null);
    assert.equal(channelNotificationLevel(feed!), "none");
  });

  it("keeps an explicit level over the kind, either way round", async () => {
    await upsertServerChannel({ channelId: "loud-feed", name: "releases", type: "text", automated: true, defaultNotificationLevel: "all" });
    await upsertServerChannel({ channelId: "quiet-chat", name: "bots", type: "text", defaultNotificationLevel: "mentions" });
    assert.equal(channelNotificationLevel((await getServerChannel("loud-feed"))!), "all");
    assert.equal(channelNotificationLevel((await getServerChannel("quiet-chat"))!), "mentions");
  });

  it("stores nothing for a level it does not know", async () => {
    await upsertServerChannel({ channelId: "junk", name: "junk", type: "text", defaultNotificationLevel: "loud" as never });
    const c = await getServerChannel("junk");
    assert.equal(c?.default_notification, null);
    assert.equal(channelNotificationLevel(c!), "all");
  });

  it("goes back to following the kind when the level is cleared", async () => {
    await upsertServerChannel({ channelId: "feed", name: "git-activity", type: "text", automated: true, defaultNotificationLevel: null });
    assert.equal(channelNotificationLevel((await getServerChannel("feed"))!), "none");
  });
});

describe("what a member is sent", () => {
  it("names the level on every channel, from the sidebar and from the fallback list", async () => {
    const owner = await upsertUser("account-owner", "Owner");
    await setServerRole(owner.server_user_id, "owner");

    // A sidebar naming no channel is what reaches the fallback list.
    await upsertServerSidebarItem({ itemId: "sb_sep", kind: "separator", label: "Feeds" });
    const fallback = await detailsFor("account-owner", owner.server_user_id);
    const byId = new Map((fallback.channels ?? []).map((c) => [c.id, c]));
    assert.equal(byId.get("plain")?.defaultNotificationLevel, "all");
    assert.equal(byId.get("feed")?.defaultNotificationLevel, "none");
    assert.equal(byId.get("loud-feed")?.defaultNotificationLevel, "all");
    assert.equal(byId.get("quiet-chat")?.defaultNotificationLevel, "mentions");

    await upsertServerSidebarItem({ itemId: "sb_ch_plain", kind: "channel", channelId: "plain", position: 10 });
    await upsertServerSidebarItem({ itemId: "sb_ch_feed", kind: "channel", channelId: "feed", position: 20 });
    const listed = await detailsFor("account-owner", owner.server_user_id);
    const rows = new Map((listed.channels ?? []).map((c) => [c.id, c]));
    assert.equal(rows.size, 2, "the sidebar-derived list was not the one sent");
    assert.equal(rows.get("plain")?.defaultNotificationLevel, "all");
    assert.equal(rows.get("feed")?.defaultNotificationLevel, "none");
  });
});
