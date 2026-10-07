import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { blockUser } from "../../db/sqlite/blocks";
import { upsertServerChannel, upsertServerSidebarItem } from "../../db/sqlite/channels";
import { createPermissionScope, replacePermissionRules, setChannelPermissionScope } from "../../db/sqlite/channelScopes";
import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { listPushDevices } from "../../db/sqlite/pushDevices";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { setUserInactive, upsertUser } from "../../db/sqlite/users";
import { resetChannelPermissionCache } from "../../services/channelPermissions";
import { resetPushState } from "../../services/push";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { refreshClientPermissions } from "../utils/standing";
import { registerChatHandlers } from "./chat";
import { registerDirectMessageHandlers } from "./dm";
import { registerPushHandlers } from "./push";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Who a message wakes, end to end through the real handlers, with a local server
 * standing in for the relay (GRYT-1656, GRYT-1689).
 */

const HOST = "push.test:5001";
const OPEN = "general";
const STAFF = "staff";
const KEPT_OUT = "push-outsider";

/* The relay the server talks to. Each test reads what reached it. */
let relay: Server;
const hits: { capability: string; body: string }[] = [];
const answers = new Map<string, number>();

let dir: string;

const clientsInfo: Clients = {};
const sockets = new Map<string, { emit: (event: string, payload?: unknown) => boolean }>();
const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets } };

interface Member {
  name: string;
  clientId: string;
  serverUserId: string;
  grytUserId: string;
  accessToken: string;
  capability: string;
  handlers: EventHandlerMap;
  emitted: { event: string; payload: unknown }[];
}

const members = new Map<string, Member>();
let seq = 0;

/* manage_messages keeps the spam filter out of it, which a run of mentions trips. */
const PERMISSIONS: Permission[] = [
  "read_messages", "send_messages", "send_direct_messages", "view_members", "mention_everyone", "manage_messages",
];

function capabilityFor(n: number): string {
  return `p_${String(n).padStart(2, "0")}${"x".repeat(41)}`;
}

async function member(name: string, roleId: string): Promise<Member> {
  seq += 1;
  const clientId = `push-socket-${seq}`;
  const grytUserId = `push-account-${name}`;
  const user = await upsertUser(grytUserId, name);
  await setServerRole(user.server_user_id, roleId);
  const emitted: Member["emitted"] = [];
  const emit = (event: string, payload?: unknown) => (emitted.push({ event, payload }), true);
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit,
    join() {},
    leave() {},
    to: () => ({ emit() {} }),
  };
  sockets.set(clientId, { emit });
  clientsInfo[clientId] = { serverUserId: user.server_user_id, grytUserId, nickname: name, isAFK: false } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);
  const ctx = {
    io, socket, clientId, serverId: "push-test", clientsInfo, sfuClient: null,
    getClientIp: () => `10.1.0.${seq}`, clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  const m: Member = {
    name, clientId, grytUserId,
    serverUserId: user.server_user_id,
    accessToken: generateAccessToken({ grytUserId, serverUserId: user.server_user_id, nickname: name, serverHost: HOST, tokenVersion: 0 }),
    capability: capabilityFor(seq),
    handlers: { ...registerChatHandlers(ctx), ...registerDirectMessageHandlers(ctx), ...registerPushHandlers(ctx) },
    emitted,
  };
  members.set(m.capability, m);
  return m;
}

/** Through the handler, as the phone does it. */
async function register(m: Member, muted?: string[]): Promise<void> {
  const reply = await new Promise((resolve) =>
    m.handlers["push:register"]({ accessToken: m.accessToken, installId: `install-${m.name}`, capability: m.capability, muted }, resolve),
  );
  assert.deepEqual(reply, { ok: true }, `${m.name} could not register`);
}

function away(m: Member, how: "phone" | "afk" | "gone" = "phone"): void {
  if (how === "gone") delete clientsInfo[m.clientId];
  else clientsInfo[m.clientId] = { ...clientsInfo[m.clientId], appInBackground: how === "phone", isAFK: how === "afk" } as Clients[string];
}

function back(m: Member): void {
  clientsInfo[m.clientId] = {
    ...(clientsInfo[m.clientId] ?? { serverUserId: m.serverUserId, grytUserId: m.grytUserId, nickname: m.name }),
    appInBackground: false,
    isAFK: false,
  } as Clients[string];
}

/** Pushes are fire and forget, so wait until the relay has been quiet for a moment. */
async function woken(): Promise<string[]> {
  let seen = -1;
  while (seen !== hits.length) {
    seen = hits.length;
    await new Promise((r) => setTimeout(r, 60));
  }
  return hits.map((h) => `${members.get(h.capability)?.name ?? "?"}:${JSON.parse(h.body).kind}`).sort();
}

async function send(from: Member, conversationId: string, text: string): Promise<void> {
  await from.handlers["chat:send"]({ accessToken: from.accessToken, conversationId, text });
  const refused = from.emitted.find((e) => e.event === "chat:error");
  assert.equal(refused, undefined, `${from.name}'s message was refused: ${JSON.stringify(refused?.payload)}`);
}

async function openDm(from: Member, to: Member): Promise<string> {
  from.emitted.length = 0;
  await from.handlers["dm:open"]({ accessToken: from.accessToken, targetServerUserId: to.serverUserId });
  const opened = from.emitted.find((e) => e.event === "dm:opened")?.payload as { conversation_id?: string } | undefined;
  assert.ok(opened?.conversation_id, `no DM between ${from.name} and ${to.name}`);
  return opened.conversation_id;
}

let alice: Member;
let bob: Member;
let carol: Member;
let dave: Member;
let erin: Member;

before(async () => {
  relay = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const capability = String(req.headers.authorization ?? "").replace("Bearer ", "");
      hits.push({ capability, body });
      res.writeHead(answers.get(capability) ?? 202);
      res.end();
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  process.env.GRYT_PUSH_RELAY_URL = `http://localhost:${(relay.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), "gryt-push-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({ channelId: OPEN, name: "General", type: "text", position: 10 });
  await upsertServerChannel({ channelId: STAFF, name: "Staff", type: "text", position: 20 });
  await upsertServerSidebarItem({ itemId: "sb-general", kind: "channel", position: 10, channelId: OPEN });
  await upsertServerSidebarItem({ itemId: "sb-staff", kind: "channel", position: 20, channelId: STAFF });

  await createRoleDefinition("push-member", { name: "push-member", rank: 50, permissions: PERMISSIONS });
  await createRoleDefinition(KEPT_OUT, { name: "push-outsider", rank: 10, permissions: PERMISSIONS });
  const staffOnly = await createPermissionScope({ name: "Staff only", isTemplate: true });
  await replacePermissionRules(staffOnly, [{ roleId: KEPT_OUT, permission: "read_messages", effect: "deny" }]);
  await setChannelPermissionScope(STAFF, staffOnly);
  resetChannelPermissionCache();
  resetChannelIdCache();

  alice = await member("Alice", "push-member");
  bob = await member("Bob", KEPT_OUT);
  carol = await member("Carol", "push-member");
  dave = await member("Dave", "push-member");
  erin = await member("Erin", "push-member");
});

after(() => {
  relay.close();
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

let text = 0;
/** Fresh words each time, so the spam filter never sees the same line twice. */
const line = (s: string) => `${s} (${++text})`;

beforeEach(async () => {
  resetPushState();
  resetRateLimits();
  for (const m of [alice, bob, carol, dave, erin]) {
    back(m);
    m.emitted.length = 0;
    await register(m);
  }
  answers.clear();
  hits.length = 0;
});

describe("mentions", () => {
  it("wake somebody whose phone is in the background, with only the kind", async () => {
    away(carol);
    await send(alice, OPEN, line("@Carol look at this"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
    assert.deepEqual(JSON.parse(hits[0].body), { kind: "mention" }, "the relay got more than the kind");
  });

  it("don't wake somebody at a screen", async () => {
    await send(alice, OPEN, line("@Carol are you here"));
    assert.deepEqual(await woken(), []);
  });

  it("wake somebody whose desktop has gone idle", async () => {
    away(carol, "afk");
    await send(alice, OPEN, line("@Carol idle?"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
  });

  it("wake somebody with no socket at all", async () => {
    away(carol, "gone");
    await send(alice, OPEN, line("@Carol offline"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
  });

  it("don't wake somebody who can't read the channel", async () => {
    away(bob);
    away(carol);
    await send(alice, STAFF, line("@Bob @Carol staff only"));
    assert.deepEqual(await woken(), ["Carol:mention"], "Bob was woken for a channel he can't see");
  });

  it("don't wake the sender for mentioning themselves", async () => {
    away(alice);
    await send(alice, OPEN, line("@Alice note to self"));
    assert.deepEqual(await woken(), []);
  });

  it("don't wake anybody for @everyone or @here", async () => {
    for (const m of [bob, carol, dave, erin]) away(m);
    await send(alice, OPEN, line("@everyone and @here, hello"));
    assert.deepEqual(await woken(), []);
  });

  it("don't wake somebody who blocked the sender", async () => {
    await blockUser(erin.grytUserId, alice.grytUserId);
    away(erin);
    await send(alice, OPEN, line("@Erin hey"));
    assert.deepEqual(await woken(), []);
  });

  it("don't wake a phone that muted the channel", async () => {
    await register(carol, [OPEN]);
    away(carol);
    await send(alice, OPEN, line("@Carol muted here"));
    assert.deepEqual(await woken(), []);
  });

  it("still wake a phone that muted some other channel", async () => {
    await register(carol, [STAFF]);
    away(carol);
    await send(alice, OPEN, line("@Carol but not here"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
  });
});

describe("direct messages", () => {
  it("wake the other person and never the sender", async () => {
    const dm = await openDm(alice, dave);
    away(alice);
    away(dave);
    await send(alice, dm, line("hi Dave"));
    assert.deepEqual(await woken(), ["Dave:dm"]);
    assert.deepEqual(JSON.parse(hits[0].body), { kind: "dm" });
  });

  it("buzz once for a burst in the same conversation", async () => {
    const dm = await openDm(carol, dave);
    away(dave);
    await send(carol, dm, line("one"));
    await send(carol, dm, line("two"));
    await send(carol, dm, line("three"));
    assert.deepEqual(await woken(), ["Dave:dm"]);
  });

  it("don't wake a phone that muted the conversation", async () => {
    const dm = await openDm(erin, dave);
    await register(dave, [dm]);
    away(dave);
    await send(erin, dm, line("muted DM"));
    assert.deepEqual(await woken(), []);
  });
});

describe("taking it back", () => {
  it("stops after push:unregister", async () => {
    const reply = await new Promise((resolve) =>
      carol.handlers["push:unregister"]({ accessToken: carol.accessToken, installId: "install-Carol" }, resolve),
    );
    assert.deepEqual(reply, { ok: true });
    away(carol);
    await send(alice, OPEN, line("@Carol after unregistering"));
    assert.deepEqual(await woken(), []);
  });

  it("forgets a phone the relay calls gone", async () => {
    answers.set(carol.capability, 410);
    away(carol);
    await send(alice, OPEN, line("@Carol gone phone"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
    assert.deepEqual(listPushDevices(carol.serverUserId), [], "the server kept a capability the relay dropped");
  });

  it("stops for a phone that hasn't checked in for a month", async () => {
    getSqliteDb()
      .prepare(`UPDATE push_devices SET updated_at = ? WHERE server_user_id = ?`)
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), carol.serverUserId);
    away(carol);
    await send(alice, OPEN, line("@Carol in a drawer"));
    assert.deepEqual(await woken(), []);
    assert.equal(getSqliteDb().prepare(`SELECT COUNT(*) AS n FROM push_devices WHERE server_user_id = ?`).get(carol.serverUserId)?.n, 0);
  });

  it("drops every phone of somebody who left, was kicked or was banned", async () => {
    await setUserInactive(carol.serverUserId);
    assert.deepEqual(listPushDevices(carol.serverUserId), []);
    getSqliteDb().prepare(`UPDATE users SET is_active = 1 WHERE server_user_id = ?`).run(carol.serverUserId);
  });
});

describe("push:register", () => {
  it("refuses a muted list that isn't a short list of ids", async () => {
    for (const muted of ["general", [1, 2], Array.from({ length: 1001 }, (_, i) => `c${i}`), ["x".repeat(129)]]) {
      const reply = await new Promise((resolve) =>
        carol.handlers["push:register"]({ accessToken: carol.accessToken, installId: "install-Carol", capability: carol.capability, muted }, resolve),
      );
      assert.deepEqual(reply, { ok: false, error: "invalid_payload" }, JSON.stringify(muted).slice(0, 40));
    }
  });

  it("refuses a capability that isn't one", async () => {
    const reply = await new Promise((resolve) =>
      carol.handlers["push:register"]({ accessToken: carol.accessToken, installId: "install-Carol", capability: "https://evil.example" }, resolve),
    );
    assert.deepEqual(reply, { ok: false, error: "invalid_payload" });
  });
});
