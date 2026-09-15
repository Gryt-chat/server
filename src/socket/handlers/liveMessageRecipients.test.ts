import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { upsertServerChannel } from "../../db/sqlite/channels";
import {
  createPermissionScope,
  replacePermissionRules,
  setChannelPermissionScope,
} from "../../db/sqlite/channelScopes";
import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { refreshClientPermissions } from "../utils/standing";
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * The live path handed a channel's messages to every connected socket, joined
 * or not. These assert who a message actually reaches, per socket id.
 */

const HOST = "recipients.test:5001";
const OPEN = "general";
const HIDDEN = "staff";
const LOW_ROLE = "recip-low";

let dir: string;

interface Party {
  grytUserId: string;
  serverUserId: string;
  accessToken: string;
}

/** A member on `role`, whose permissions come from that role's definition. */
async function memberAt(name: string, role: string): Promise<Party> {
  const grytUserId = `account-${name}`;
  const user = await upsertUser(grytUserId, name);
  await setServerRole(user.server_user_id, role);
  return {
    grytUserId,
    serverUserId: user.server_user_id,
    accessToken: generateAccessToken({ grytUserId, serverUserId: user.server_user_id, nickname: name, serverHost: HOST, tokenVersion: 0 }),
  };
}

let poster: Party;
let reader: Party;
let noRead: Party;
let lowVis: Party;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-recipients-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: OPEN, name: "General", type: "text", position: 10 });
  await upsertServerChannel({ channelId: HIDDEN, name: "Staff", type: "text", position: 20 });

  const POST: Permission[] = ["read_messages", "send_messages", "view_members", "add_reactions", "edit_own_messages", "delete_own_messages", "manage_messages"];
  await createRoleDefinition("recip-poster", { name: "Poster", rank: 50, permissions: POST });
  await createRoleDefinition("recip-reader", { name: "Reader", rank: 40, permissions: ["read_messages", "view_members"] });
  await createRoleDefinition("recip-noread", { name: "No read", rank: 30, permissions: ["view_members"] });
  await createRoleDefinition(LOW_ROLE, { name: "Low", rank: 20, permissions: ["read_messages", "view_members"] });

  poster = await memberAt("poster", "recip-poster");
  reader = await memberAt("reader", "recip-reader");
  noRead = await memberAt("noread", "recip-noread");
  lowVis = await memberAt("low", LOW_ROLE);

  // Denying read to the low role hides HIDDEN from it, and from it alone.
  const scope = await createPermissionScope({ name: "Staff only", isTemplate: true });
  await replacePermissionRules(scope, [{ roleId: LOW_ROLE, permission: "read_messages", effect: "deny" }]);
  await setChannelPermissionScope(HIDDEN, scope);

  resetChannelPermissionCache();
  resetChannelIdCache();
});

after(() => {
  delete process.env.DATA_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file open past the run; a temp dir is not worth failing over.
  }
});

beforeEach(() => resetRateLimits());

/** Every recipient's socket, plus a raw unjoined one and one whose standing was
    cleared, all recording what they were sent. The sender drives the handlers. */
async function harness(sender: Party) {
  const emitted = new Map<string, { event: string; payload?: unknown }[]>();
  const clientsInfo: Clients = {};
  const sockets = new Map<string, { id: string; emit: (e: string, p?: unknown) => boolean }>();

  const add = (cid: string, entry: Partial<Clients[string]>) => {
    const log: { event: string; payload?: unknown }[] = [];
    emitted.set(cid, log);
    sockets.set(cid, {
      id: cid,
      emit(event: string, payload?: unknown) { log.push({ event, payload }); return true; },
    });
    clientsInfo[cid] = entry as Clients[string];
  };

  // The real members get the cache the join path would have set from their role.
  add("s_poster", { serverUserId: poster.serverUserId, grytUserId: poster.grytUserId, nickname: "poster" });
  add("s_reader", { serverUserId: reader.serverUserId, grytUserId: reader.grytUserId, nickname: "reader" });
  add("s_noread", { serverUserId: noRead.serverUserId, grytUserId: noRead.grytUserId, nickname: "noread" });
  add("s_low", { serverUserId: lowVis.serverUserId, grytUserId: lowVis.grytUserId, nickname: "low" });
  for (const cid of ["s_poster", "s_reader", "s_noread", "s_low"]) {
    await refreshClientPermissions(clientsInfo, cid);
  }
  // Never joined: a temp id and no cached standing at all.
  add("s_raw", { serverUserId: "temp_raw", nickname: "User" });
  // A real member whose standing was cleared, so permissions is left undefined.
  add("s_dropped", { serverUserId: reader.serverUserId, grytUserId: reader.grytUserId, nickname: "reader" });

  const senderCid = sender.serverUserId === poster.serverUserId ? "s_poster" : "s_reader";
  const socket = {
    ...sockets.get(senderCid)!,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    join() {}, leave() {}, to: () => ({ emit() {} }),
  };
  sockets.set(senderCid, socket as never);

  const io = {
    to: () => ({ emit() {} }),
    emit() {},
    sockets: { sockets },
  };

  const ctx = {
    io, socket, clientId: senderCid, serverId: "recipients-test", clientsInfo,
    sfuClient: null, getClientIp: () => "127.0.0.1", clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  const handlers: EventHandlerMap = registerChatHandlers(ctx);
  const heard = (cid: string, event: string) => (emitted.get(cid) ?? []).filter((e) => e.event === event);
  return { handlers, senderAccessToken: sender.accessToken, heard };
}

describe("who a channel message reaches", () => {
  it("delivers to joined readers and to nobody without standing, in an open channel", async () => {
    const h = await harness(poster);
    await h.handlers["chat:send"]({ conversationId: OPEN, accessToken: h.senderAccessToken, text: "hello everyone" });

    assert.equal(h.heard("s_poster", "chat:new").length, 1, "the sender did not get their own copy");
    assert.equal(h.heard("s_reader", "chat:new").length, 1, "a joined reader missed the message");
    assert.equal(h.heard("s_low", "chat:new").length, 1, "an open-channel reader missed the message");

    assert.equal(h.heard("s_raw", "chat:new").length, 0, "a socket that never joined received a channel message");
    assert.equal(h.heard("s_noread", "chat:new").length, 0, "a member without read_messages received a channel message");
    assert.equal(h.heard("s_dropped", "chat:new").length, 0, "a socket whose standing was cleared received a channel message");
  });

  it("keeps a scoped channel's message off a member who cannot see it", async () => {
    const h = await harness(poster);
    await h.handlers["chat:send"]({ conversationId: HIDDEN, accessToken: h.senderAccessToken, text: "staff only" });

    assert.equal(h.heard("s_poster", "chat:new").length, 1, "the sender did not get their own copy");
    assert.equal(h.heard("s_reader", "chat:new").length, 1, "a member who can see the channel missed it");

    assert.equal(h.heard("s_low", "chat:new").length, 0, "a member denied the channel still received its message");
    assert.equal(h.heard("s_raw", "chat:new").length, 0, "a socket that never joined received a scoped message");
    assert.equal(h.heard("s_noread", "chat:new").length, 0, "a member without read_messages received a scoped message");
  });

  it("applies the same audience to reactions and edits", async () => {
    const h = await harness(poster);
    await h.handlers["chat:send"]({ conversationId: OPEN, accessToken: h.senderAccessToken, text: "react to me" });
    const messageId = (h.heard("s_poster", "chat:new").at(-1)?.payload as { message_id?: string })?.message_id;
    assert.ok(messageId, "the message was not accepted");

    await h.handlers["chat:react"]({ conversationId: OPEN, messageId, reactionSrc: "👍", accessToken: h.senderAccessToken });
    assert.equal(h.heard("s_reader", "chat:reaction").length, 1, "a reader missed the reaction");
    assert.equal(h.heard("s_raw", "chat:reaction").length, 0, "an unjoined socket received a reaction");
    assert.equal(h.heard("s_noread", "chat:reaction").length, 0, "a read-less member received a reaction");

    await h.handlers["chat:edit"]({ conversationId: OPEN, messageId, text: "edited", accessToken: h.senderAccessToken });
    assert.equal(h.heard("s_reader", "chat:edited").length, 1, "a reader missed the edit");
    assert.equal(h.heard("s_raw", "chat:edited").length, 0, "an unjoined socket received an edit");
  });

  it("excludes the deleted message from an unjoined socket", async () => {
    const h = await harness(poster);
    await h.handlers["chat:send"]({ conversationId: OPEN, accessToken: h.senderAccessToken, text: "delete me" });
    const messageId = (h.heard("s_poster", "chat:new").at(-1)?.payload as { message_id?: string })?.message_id;
    assert.ok(messageId, "the message was not accepted");

    await h.handlers["chat:delete"]({ conversationId: OPEN, messageId, accessToken: h.senderAccessToken });
    assert.equal(h.heard("s_reader", "chat:deleted").length, 1, "a reader was not told of the deletion");
    assert.equal(h.heard("s_raw", "chat:deleted").length, 0, "an unjoined socket was told a message was deleted");
    assert.equal(h.heard("s_noread", "chat:deleted").length, 0, "a read-less member was told a message was deleted");
  });
});
