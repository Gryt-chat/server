import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import {
  listServerChannels,
  listServerSidebarItems,
  upsertServerSidebarItem,
} from "../../db/sqlite/channels";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerAdminChannelHandlers } from "./adminChannels";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * A channel that is created has to be a channel somebody can see.
 *
 * `server:details` builds its channel list from the sidebar, and
 * `ensureDefaultSidebarItems` seeds rows once and then returns early forever
 * after. So on a server whose sidebar is already populated, a channel created
 * through `server:channels:upsert` had no row and appeared to nobody — while
 * existing, answering `chat:fetch` and accepting `chat:send`.
 *
 * The desktop has always sent `server:sidebar:item:upsert` itself immediately
 * afterwards, which is the only reason this was survivable. These cases are
 * about the handler being right on its own. GRYT-839.
 */

const HOST = "sidebar.test:5001";

let dir: string;
let handlers: EventHandlerMap;
let accessToken: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-sidebar-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  const user = await upsertUser("account-sidebar-1", "Ada");
  await setServerRole(user.server_user_id, "owner");

  const socket = {
    id: "socket-1",
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: () => true,
    join() {},
    leave() {},
    to: () => ({ emit() {} }),
  };

  const clientsInfo: Clients = {};
  clientsInfo["socket-1"] = {
    serverUserId: user.server_user_id,
    grytUserId: "account-sidebar-1",
    nickname: "Ada",
  } as Clients[string];

  const ctx = {
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
    socket,
    clientId: "socket-1",
    serverId: "sidebar-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "10.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  handlers = registerAdminChannelHandlers(ctx);
  accessToken = generateAccessToken({
    grytUserId: "account-sidebar-1",
    serverUserId: user.server_user_id,
    nickname: "Ada",
    serverHost: HOST,
    tokenVersion: 0,
  });

  // A sidebar that is already populated, which is the state the bug needed:
  // `ensureDefaultSidebarItems` will not seed over this.
  await upsertServerSidebarItem({ itemId: "sb_existing", kind: "channel", channelId: "existing", position: 10 });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const rowsFor = async (channelId: string) =>
  (await listServerSidebarItems()).filter((i) => i.kind === "channel" && i.channel_id === channelId);

describe("a new channel gets a sidebar row", () => {
  it("adds one, so the channel is drawn at all", async () => {
    await handlers["server:channels:upsert"]({
      accessToken, channelId: "c-new", name: "new", type: "text",
    });

    const rows = await rowsFor("c-new");
    assert.equal(rows.length, 1, "a created channel with no sidebar row is invisible to every client");
  });

  it("puts it after what is already there rather than on top of it", async () => {
    const rows = await rowsFor("c-new");
    const existing = (await listServerSidebarItems()).find((i) => i.item_id === "sb_existing");
    assert.ok(rows[0].position > (existing?.position ?? 0));
  });

  /*
   * Removing a channel from the sidebar and keeping the channel is something
   * somebody can deliberately do. Renaming it must not undo that.
   */
  it("adds nothing on an edit", async () => {
    for (const row of await rowsFor("c-new")) {
      await handlers["server:sidebar:item:delete"]({ accessToken, itemId: row.item_id });
    }
    assert.equal((await rowsFor("c-new")).length, 0, "precondition: the row is gone");

    await handlers["server:channels:upsert"]({
      accessToken, channelId: "c-new", name: "renamed", type: "text",
    });

    assert.equal((await rowsFor("c-new")).length, 0, "an edit put the row back");
    const channel = (await listServerChannels()).find((c) => c.channel_id === "c-new");
    assert.equal(channel?.name, "renamed", "the rename itself still happened");
  });
});

describe("one row per channel", () => {
  /*
   * The case the fix above would otherwise cause. The desktop sends
   * `server:channels:upsert` and `server:sidebar:item:upsert` back to back with
   * an item id of its own, so the channel would be given a row here and a
   * second one a moment later — and two rows draw the channel twice.
   */
  it("drops the row added alongside the channel when a client names its own", async () => {
    await handlers["server:channels:upsert"]({
      accessToken, channelId: "c-desktop", name: "desktop", type: "text",
    });
    assert.equal((await rowsFor("c-desktop")).length, 1, "precondition: the handler added one");

    await handlers["server:sidebar:item:upsert"]({
      accessToken, itemId: "sb_client_choice", kind: "channel", channelId: "c-desktop", position: 40,
    });

    const rows = await rowsFor("c-desktop");
    assert.equal(rows.length, 1, "the channel would be drawn twice");
    assert.equal(rows[0].item_id, "sb_client_choice", "the explicitly named row is the one kept");
  });

  it("leaves separators and spacers alone", async () => {
    await handlers["server:sidebar:item:upsert"]({
      accessToken, itemId: "sb_sep_1", kind: "separator", position: 50, label: "Rooms",
    });
    await handlers["server:sidebar:item:upsert"]({
      accessToken, itemId: "sb_sep_2", kind: "separator", position: 60, label: "Voice",
    });

    const items = await listServerSidebarItems();
    const separators = items.filter((i) => i.kind === "separator");
    assert.equal(separators.length, 2, "two separators carry no channel and must not collapse into one");
  });
});
