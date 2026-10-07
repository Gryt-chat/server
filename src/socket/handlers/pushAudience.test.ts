import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
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
import { pushesSettled, resetPushState } from "../../services/push";
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

/** Through the handler, as the phone does it. A bare list is what it mutes. */
async function register(
  m: Member,
  settings: string[] | { muted?: string[]; all?: string[]; everyone?: boolean; previewKey?: string } = {},
): Promise<void> {
  const { muted, all, everyone, previewKey } = Array.isArray(settings)
    ? { muted: settings, all: undefined, everyone: undefined, previewKey: undefined }
    : settings;
  const reply = await new Promise((resolve) =>
    m.handlers["push:register"](
      { accessToken: m.accessToken, installId: `install-${m.name}`, capability: m.capability, muted, all, everyone, previewKey },
      resolve,
    ),
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

/** Pushes are fire and forget, so wait for every one sent to have been answered. A quiet spell lost them under load. */
async function woken(): Promise<string[]> {
  await pushesSettled();
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

  it("don't wake anybody for @everyone or @here from a phone that suppresses them", async () => {
    for (const m of [bob, carol, dave, erin]) away(m);
    await send(alice, OPEN, line("@everyone and @here, hello"));
    assert.deepEqual(await woken(), []);
  });

  it("wake a phone that lets @everyone through, like the desktop does", async () => {
    await register(carol, { everyone: true });
    for (const m of [bob, carol, dave, erin]) away(m);
    await send(alice, OPEN, line("@everyone, meeting"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
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

describe("every message, for a phone at All", () => {
  it("wakes a phone at All for a plain message, and one left at mentions stays quiet", async () => {
    await register(carol, { all: [OPEN] });
    away(carol);
    away(dave);
    await send(alice, OPEN, line("nothing special"));
    assert.deepEqual(await woken(), ["Carol:message"]);
    assert.deepEqual(JSON.parse(hits[0].body), { kind: "message" });
  });

  it("only for the conversations at All", async () => {
    await register(carol, { all: [STAFF] });
    away(carol);
    await send(alice, OPEN, line("in general"));
    assert.deepEqual(await woken(), []);
  });

  it("buzzes once for a burst", async () => {
    await register(carol, { all: [OPEN] });
    away(carol);
    for (const word of ["one", "two", "three"]) await send(alice, OPEN, line(word));
    assert.deepEqual(await woken(), ["Carol:message"]);
  });

  it("a mention there arrives as a mention, not twice", async () => {
    await register(carol, { all: [OPEN] });
    away(carol);
    await send(alice, OPEN, line("@Carol in a loud channel"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
  });

  it("not somebody at a screen, nor the sender", async () => {
    await register(carol, { all: [OPEN] });
    await register(alice, { all: [OPEN] });
    away(alice);
    await send(alice, OPEN, line("my own message"));
    assert.deepEqual(await woken(), []);
  });

  it("not for a channel they can no longer read", async () => {
    await register(bob, { all: [STAFF] });
    away(bob);
    await send(carol, STAFF, line("staff talk"));
    assert.deepEqual(await woken(), []);
  });

  it("muted wins when a phone sends both", async () => {
    await register(carol, { muted: [OPEN], all: [OPEN] });
    away(carol);
    await send(alice, OPEN, line("muted and loud"));
    assert.deepEqual(await woken(), []);
  });

  it("not somebody who blocked the sender", async () => {
    await blockUser(erin.grytUserId, alice.grytUserId);
    await register(erin, { all: [OPEN] });
    away(erin);
    await send(alice, OPEN, line("blocked and loud"));
    assert.deepEqual(await woken(), []);
  });

  it("refuses a setting that isn't a list of ids or a yes or no", async () => {
    const reply = await new Promise((resolve) =>
      carol.handlers["push:register"](
        { accessToken: carol.accessToken, installId: "install-Carol", capability: carol.capability, all: "general", everyone: "yes" },
        resolve,
      ),
    );
    assert.deepEqual(reply, { ok: false, error: "invalid_payload" });
  });
});

/** What the phone's extension does with a preview, written from the format. */
function openPreview(previewKey: string, capability: string, blob: string): unknown {
  const raw = Buffer.from(blob, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(previewKey, "base64url"), raw.subarray(1, 13));
  decipher.setAAD(Buffer.from(`gryt-push-1|${createHash("sha256").update(capability).digest("hex").slice(0, 16)}`));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(13, raw.length - 16)), decipher.final()]).toString("utf8"));
}

describe("previews sealed to the phone (GRYT-1688)", () => {
  const key = randomBytes(32).toString("base64url");

  it("a mention shows who, where, and the line, and only the phone's key opens it", async () => {
    await register(carol, { previewKey: key });
    away(carol);
    await send(alice, OPEN, "@Carol the build is green");
    assert.deepEqual(await woken(), ["Carol:mention"]);
    const body = JSON.parse(hits[0].body) as { kind: string; preview: string };
    assert.ok(!hits[0].body.includes("green"), "the relay could read the message");
    assert.deepEqual(openPreview(key, carol.capability, body.preview), {
      t: "Alice", s: "#General · Gryt", b: "@Carol the build is green",
    });
  });

  it("a direct message leaves the channel out", async () => {
    await register(dave, { previewKey: key });
    const dm = await openDm(erin, dave);
    away(dave);
    await send(erin, dm, "lunch?");
    assert.deepEqual(await woken(), ["Dave:dm"]);
    const body = JSON.parse(hits[0].body) as { preview: string };
    assert.deepEqual(openPreview(key, dave.capability, body.preview), { t: "Erin", s: "Gryt", b: "lunch?" });
  });

  it("a phone without a key gets the relay's fixed text, as before", async () => {
    away(carol);
    await send(alice, OPEN, line("@Carol no key"));
    assert.deepEqual(await woken(), ["Carol:mention"]);
    assert.deepEqual(JSON.parse(hits[0].body), { kind: "mention" });
  });

  it("refuses a key that isn't 32 bytes of base64url", async () => {
    const reply = await new Promise((resolve) =>
      carol.handlers["push:register"](
        { accessToken: carol.accessToken, installId: "install-Carol", capability: carol.capability, previewKey: "short" },
        resolve,
      ),
    );
    assert.deepEqual(reply, { ok: false, error: "invalid_payload" });
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
    for (const muted of ["general", [1, 2], Array.from({ length: 2001 }, (_, i) => `c${i}`), ["x".repeat(129)]]) {
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
