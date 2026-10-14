import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { upsertServerChannel } from "../../db/sqlite/channels";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { initSqlite } from "../../db/sqlite/connection";
import { insertMessage } from "../../db/sqlite/messages";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import type { Clients } from "../../types";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { registerChatHandlers } from "./chat";
import type { HandlerContext } from "./types";

/** GRYT-1738: search offers only channels the asker may read, never hidden ones, DMs or voice text. */

const HOST = "chat-search.test:5001";
const MEMBER_ROLE = "cs-member";
const basics: Permission[] = ["read_messages", "send_messages", "view_members"];

let dir: string;
let memberId = "";
let ipSeq = 0;

function harness(serverUserId: string, grytUserId: string) {
  const emitted: { event: string; payload: unknown }[] = [];
  const clientId = `sock-${serverUserId}`;
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
    [clientId]: { serverUserId, grytUserId, nickname: grytUserId, permissions: new Set<Permission>(basics) } as unknown as Clients[string],
  };
  ipSeq += 1;
  const ctx = {
    io: { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map([[clientId, socket]]) } },
    socket,
    clientId,
    serverId: "chat-search-test",
    clientsInfo,
    sfuClient: { isConnected: () => true, getActiveUsers: () => new Map() },
    getClientIp: () => `10.47.0.${ipSeq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  return { ctx, emitted };
}

async function search(payload: Record<string, unknown>) {
  const h = harness(memberId, "account-cs-member");
  await registerChatHandlers(h.ctx)["chat:search"](payload);
  const results = h.emitted.find((e) => e.event === "chat:search:results")?.payload as {
    items: { conversation_id: string; message_id: string }[];
    error?: string;
  };
  return results;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-chat-search-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await createRoleDefinition(MEMBER_ROLE, { name: "Member", rank: 10, permissions: basics });
  const user = await upsertUser("account-cs-member", "member");
  memberId = user.server_user_id;
  await setServerRole(memberId, MEMBER_ROLE);

  await upsertServerChannel({ channelId: "cs-general", name: "general", type: "text" });
  await upsertServerChannel({ channelId: "cs-voice", name: "voice", type: "voice" });
  await upsertServerChannel({ channelId: "cs-staff", name: "staff", type: "text" });
  const scopeId = await createPermissionScope({ scopeId: "scope-cs-staff" });
  await replacePermissionRules(scopeId, [{ roleId: MEMBER_ROLE, permission: "read_messages", effect: "deny" }]);
  await setChannelPermissionScope("cs-staff", scopeId);
  resetChannelPermissionCache();
  resetChannelIdCache();

  const post = (conversation_id: string, text: string) =>
    insertMessage({ conversation_id, sender_server_id: "someone", text, attachments: null, reactions: null } as Parameters<typeof insertMessage>[0]);
  await post("cs-general", "the launch is on friday");
  await post("cs-staff", "the launch date is secret");
  await post("cs-voice", "launch music in voice");
  await post("dm-cs-member-someone", "launch plans in a dm");
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("chat:search", () => {
  it("finds matches in channels the member can read", async () => {
    const r = await search({ query: "launch" });
    assert.deepEqual(r.items.map((i) => i.conversation_id), ["cs-general"]);
  });

  it("never offers a hidden channel, voice-channel text or a DM, even when named", async () => {
    for (const conversationId of ["cs-staff", "cs-voice", "dm-cs-member-someone"]) {
      const r = await search({ query: "launch", conversationId });
      assert.deepEqual(r.items, [], conversationId);
    }
  });

  it("answers a blank query with nothing rather than an error", async () => {
    const r = await search({ query: "   " });
    assert.deepEqual(r.items, []);
    assert.equal(r.error, undefined);
  });
});
