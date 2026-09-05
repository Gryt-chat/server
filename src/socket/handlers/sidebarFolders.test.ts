import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import {
  deleteServerSidebarItem,
  listServerSidebarItems,
  upsertServerSidebarItem,
} from "../../db/sqlite/channels";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerAdminChannelHandlers } from "./adminChannels";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Folders are a `parent_item_id` on the sidebar row, and everything here is
 * about that column holding only what the sidebar can actually draw.
 *
 * The sidebar renders a child under its folder and nowhere else, so a parent id
 * that resolves to nothing is not a cosmetic problem — the channel disappears.
 * Every case that cannot be drawn therefore falls back to the top level, which
 * is visible and recoverable, rather than being stored and hidden.
 */

const HOST = "folders.test:5001";

let dir: string;
let handlers: EventHandlerMap;
let accessToken: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-folders-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  const user = await upsertUser("account-folders-1", "Ada");
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
    grytUserId: "account-folders-1",
    nickname: "Ada",
  } as Clients[string];

  const ctx = {
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } },
    socket,
    clientId: "socket-1",
    serverId: "folders-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => "10.0.0.1",
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  handlers = registerAdminChannelHandlers(ctx);
  accessToken = generateAccessToken({
    grytUserId: "account-folders-1",
    serverUserId: user.server_user_id,
    nickname: "Ada",
    serverHost: HOST,
    tokenVersion: 0,
  });
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const itemById = async (itemId: string) =>
  (await listServerSidebarItems()).find((i) => i.item_id === itemId);

const parentOf = async (itemId: string) => (await itemById(itemId))?.parent_item_id ?? null;

describe("sidebar folders", () => {
  it("stores a folder with its name", async () => {
    await upsertServerSidebarItem({ itemId: "f1", kind: "folder", label: "Voice rooms", position: 10 });

    const folder = await itemById("f1");
    assert.equal(folder?.kind, "folder");
    assert.equal(folder?.label, "Voice rooms");
    // A folder is not a channel, so it names none.
    assert.equal(folder?.channel_id, null);
  });

  it("puts a channel in a folder", async () => {
    await upsertServerSidebarItem({ itemId: "c1", kind: "channel", channelId: "chan-1", position: 20, parentItemId: "f1" });
    assert.equal(await parentOf("c1"), "f1");
  });

  /*
   * One indent step, so a folder never sits inside another. Refused here rather
   * than in the client: the client is where the drag is drawn, and this is the
   * only place that can promise the shape.
   */
  it("refuses to nest a folder in a folder", async () => {
    await upsertServerSidebarItem({ itemId: "f2", kind: "folder", label: "Inner", position: 30, parentItemId: "f1" });
    assert.equal(await parentOf("f2"), null);
  });

  it("keeps separators and spacers at the top level", async () => {
    await upsertServerSidebarItem({ itemId: "s1", kind: "separator", label: "Rules", position: 40, parentItemId: "f1" });
    await upsertServerSidebarItem({ itemId: "sp1", kind: "spacer", spacerHeight: 24, position: 50, parentItemId: "f1" });
    assert.equal(await parentOf("s1"), null);
    assert.equal(await parentOf("sp1"), null);
  });

  it("drops a parent that does not exist, so the channel stays visible", async () => {
    await upsertServerSidebarItem({ itemId: "c2", kind: "channel", channelId: "chan-2", position: 60, parentItemId: "no-such-folder" });
    assert.equal(await parentOf("c2"), null);
  });

  it("drops a parent that is not a folder", async () => {
    await upsertServerSidebarItem({ itemId: "c3", kind: "channel", channelId: "chan-3", position: 70, parentItemId: "c1" });
    assert.equal(await parentOf("c3"), null);
  });

  it("drops a channel that names itself as its folder", async () => {
    await upsertServerSidebarItem({ itemId: "c4", kind: "channel", channelId: "chan-4", position: 80, parentItemId: "c4" });
    assert.equal(await parentOf("c4"), null);
  });

  /*
   * Deleting a folder empties it. Cascading would take the channels off the
   * sidebar with it, and a channel with no sidebar row still exists and answers
   * `chat:fetch` while being unreachable — the shape of GRYT-839, arrived at
   * from the other direction.
   */
  it("promotes the children when a folder is deleted", async () => {
    await upsertServerSidebarItem({ itemId: "f3", kind: "folder", label: "Temporary", position: 90 });
    await upsertServerSidebarItem({ itemId: "c5", kind: "channel", channelId: "chan-5", position: 100, parentItemId: "f3" });
    assert.equal(await parentOf("c5"), "f3");

    await deleteServerSidebarItem("f3");

    assert.equal(await itemById("f3"), undefined);
    const child = await itemById("c5");
    assert.ok(child, "the channel row survives its folder");
    assert.equal(child?.parent_item_id, null);
  });

  /*
   * The regression that would empty every folder on the next drag of anything.
   *
   * `upsert` writes `parent_item_id` on every call, and a reorder is a series of
   * upserts. A client that sends the old flat array of ids says nothing about
   * folders, and the handler has to read parentage back off the stored row
   * rather than defaulting it to null.
   */
  it("keeps folder membership through a reorder sent as bare ids", async () => {
    assert.equal(await parentOf("c1"), "f1");

    await handlers["server:sidebar:reorder"]({
      accessToken,
      order: ["f1", "c1", "c2", "c3"],
    });

    assert.equal(await parentOf("c1"), "f1", "a bare-id reorder must not empty the folder");
  });

  it("moves a channel into a folder when the reorder says so", async () => {
    await handlers["server:sidebar:reorder"]({
      accessToken,
      order: ["f1", { itemId: "c1", parentItemId: "f1" }, { itemId: "c2", parentItemId: "f1" }],
    });

    assert.equal(await parentOf("c2"), "f1");
  });

  it("moves a channel back out when the reorder says null", async () => {
    await handlers["server:sidebar:reorder"]({
      accessToken,
      order: ["f1", { itemId: "c1", parentItemId: "f1" }, { itemId: "c2", parentItemId: null }],
    });

    assert.equal(await parentOf("c2"), null);
    assert.equal(await parentOf("c1"), "f1", "the others are left where they were");
  });

  it("renumbers positions in the order given", async () => {
    await handlers["server:sidebar:reorder"]({
      accessToken,
      order: ["c3", "f1", "c1"],
    });

    const items = await listServerSidebarItems();
    const pos = (id: string) => items.find((i) => i.item_id === id)?.position ?? -1;
    assert.ok(pos("c3") < pos("f1"), "c3 sorts before f1");
    assert.ok(pos("f1") < pos("c1"), "f1 sorts before c1");
  });
});
