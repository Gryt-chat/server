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
import { listUnseenMentions, markMentionsSeen } from "../../db/sqlite/mentions";
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

// GRYT-1455: who @everyone, @here and a role reach, and what a hidden #channel leaks.

const HOST = "mass.test:5001";
const OPEN = "general";
const HIDDEN = "staff";
const ANNOUNCE = "announce";

interface Party { name: string; grytUserId: string; serverUserId: string; accessToken: string }

async function memberAt(name: string, role: string): Promise<Party> {
  const grytUserId = `account-${name}`;
  const user = await upsertUser(grytUserId, name);
  await setServerRole(user.server_user_id, role);
  return {
    name,
    grytUserId,
    serverUserId: user.server_user_id,
    accessToken: generateAccessToken({ grytUserId, serverUserId: user.server_user_id, nickname: name, serverHost: HOST, tokenVersion: 0 }),
  };
}

let dir: string;
let boss: Party;
let plain: Party;
let reader: Party;
let crew: Party;
let away: Party;
let low: Party;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-mass-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: OPEN, name: "General", type: "text", position: 10 });
  await upsertServerChannel({ channelId: HIDDEN, name: "Staff room", type: "text", position: 20 });

  const TALK: Permission[] = ["read_messages", "send_messages", "view_members", "edit_own_messages"];
  await createRoleDefinition("mm-boss", { name: "Boss", rank: 70, permissions: [...TALK, "mention_everyone"] });
  await createRoleDefinition("mm-plain", { name: "Plain", rank: 40, permissions: TALK });
  await createRoleDefinition("mm-crew", { name: "Crew", rank: 30, permissions: TALK, mentionable: true });
  await createRoleDefinition("mm-quiet", { name: "Quiet", rank: 25, permissions: TALK });
  await createRoleDefinition("mm-low", { name: "Low", rank: 20, permissions: TALK });

  boss = await memberAt("boss", "mm-boss");
  plain = await memberAt("plain", "mm-plain");
  reader = await memberAt("reader", "mm-quiet");
  crew = await memberAt("crew", "mm-crew");
  away = await memberAt("away", "mm-plain");
  low = await memberAt("low", "mm-low");

  const scope = await createPermissionScope({ name: "Staff only", isTemplate: true });
  await replacePermissionRules(scope, [{ roleId: "mm-low", permission: "read_messages", effect: "deny" }]);
  await setChannelPermissionScope(HIDDEN, scope);

  await upsertServerChannel({ channelId: ANNOUNCE, name: "Announcements", type: "text", position: 30 });
  const loud = await createPermissionScope({ name: "Loud", isTemplate: false });
  await replacePermissionRules(loud, [{ roleId: "mm-plain", permission: "mention_everyone", effect: "allow" }]);
  await setChannelPermissionScope(ANNOUNCE, loud);

  resetChannelPermissionCache();
  resetChannelIdCache();
});

after(() => {
  delete process.env.DATA_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file open past the run.
  }
});

beforeEach(async () => {
  resetRateLimits();
  for (const p of [boss, plain, reader, crew, away, low]) await markMentionsSeen({ serverUserId: p.serverUserId });
});

/** Everybody but `away` has a socket open. */
async function harness(sender: Party) {
  const emitted = new Map<string, { event: string; payload?: unknown }[]>();
  const clientsInfo: Clients = {};
  const sockets = new Map<string, { id: string; emit: (e: string, p?: unknown) => boolean }>();

  for (const p of [boss, plain, reader, crew, low]) {
    const cid = `s_${p.name}`;
    const log: { event: string; payload?: unknown }[] = [];
    emitted.set(cid, log);
    sockets.set(cid, { id: cid, emit(event: string, payload?: unknown) { log.push({ event, payload }); return true; } });
    clientsInfo[cid] = { serverUserId: p.serverUserId, grytUserId: p.grytUserId, nickname: p.name } as Clients[string];
    await refreshClientPermissions(clientsInfo, cid);
  }

  const senderCid = `s_${sender.name}`;
  const socket = {
    ...sockets.get(senderCid)!,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    join() {}, leave() {}, to: () => ({ emit() {} }),
  };
  sockets.set(senderCid, socket as never);
  const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets } };
  const ctx = {
    io, socket, clientId: senderCid, serverId: "mass-test", clientsInfo,
    sfuClient: null, getClientIp: () => "127.0.0.1", clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  const handlers: EventHandlerMap = registerChatHandlers(ctx);
  const heard = (p: Party, event: string) => (emitted.get(`s_${p.name}`) ?? []).filter((e) => e.event === event);
  const send = async (conversationId: string, text: string) => {
    await handlers["chat:send"]({ conversationId, accessToken: sender.accessToken, text });
    const own = heard(sender, "chat:new").at(-1)?.payload as { text?: string } | undefined;
    return own?.text;
  };
  return { send, heard, handlers };
}

async function kinds(p: Party): Promise<string[]> {
  return (await listUnseenMentions(p.serverUserId)).map((m) => m.kind);
}

describe("@everyone, @here and role mentions", () => {
  it("sends @everyone from a member without the permission as plain text, pinging nobody", async () => {
    const h = await harness(plain);
    const stored = await h.send(OPEN, "@everyone lunch?");
    assert.equal(stored, "@everyone lunch?");
    for (const p of [boss, reader, crew, away, low]) {
      assert.deepEqual(await kinds(p), [], `${p.name} got a mention row`);
      assert.equal(h.heard(p, "mention:new").length, 0, `${p.name} was told of a mention`);
    }
  });

  it("reaches every reader with @everyone, online or not, and nobody who cannot read", async () => {
    const h = await harness(boss);
    const stored = await h.send(HIDDEN, "@everyone staff meeting");
    assert.equal(stored, "[@everyone](mention:everyone) staff meeting");
    for (const p of [plain, reader, crew, away]) assert.deepEqual(await kinds(p), ["everyone"], p.name);
    assert.deepEqual(await kinds(low), [], "a member who cannot read the channel was pinged");
    assert.deepEqual(await kinds(boss), [], "the sender pinged themselves");
    assert.equal(h.heard(reader, "mention:new").length, 1);
    assert.equal((h.heard(reader, "mention:new")[0].payload as { kind?: string }).kind, "everyone");
  });

  it("reaches only connected readers with @here", async () => {
    const h = await harness(boss);
    await h.send(OPEN, "@here quick one");
    for (const p of [plain, reader, crew, low]) assert.deepEqual(await kinds(p), ["here"], p.name);
    assert.deepEqual(await kinds(away), [], "@here reached somebody who is offline");
  });

  it("lets anybody ping a role marked mentionable, and only its holders", async () => {
    const h = await harness(plain);
    const stored = await h.send(OPEN, "@Crew can you check the build");
    assert.equal(stored, "[@Crew](role:mm-crew) can you check the build");
    assert.deepEqual(await kinds(crew), ["role"]);
    for (const p of [boss, reader, away, low]) assert.deepEqual(await kinds(p), [], p.name);
  });

  it("sends a role that is not mentionable as plain text from a member without the permission", async () => {
    const h = await harness(plain);
    const stored = await h.send(OPEN, "[@Quiet](role:mm-quiet) hello");
    assert.equal(stored, "@Quiet hello");
    assert.deepEqual(await kinds(reader), []);
  });

  it("follows a channel that allows Mention everyone to a role without it", async () => {
    const h = await harness(plain);
    assert.equal(await h.send(ANNOUNCE, "@everyone release is out"), "[@everyone](mention:everyone) release is out");
    assert.deepEqual(await kinds(reader), ["everyone"]);
    assert.equal(await h.send(OPEN, "@everyone release is out"), "@everyone release is out");
  });

  it("keeps the more specific kind when a role holder is also named by @everyone", async () => {
    const h = await harness(boss);
    await h.send(OPEN, "@everyone and especially @Crew");
    assert.deepEqual(await kinds(crew), ["role"]);
    assert.deepEqual(await kinds(reader), ["everyone"]);
  });

  it("downgrades an edit that adds a ping the sender could not send", async () => {
    const h = await harness(plain);
    await h.send(OPEN, "first draft");
    const id = (h.heard(plain, "chat:new").at(-1)?.payload as { message_id: string }).message_id;
    await h.handlers["chat:edit"]({ conversationId: OPEN, messageId: id, text: "[@everyone](mention:everyone) now", accessToken: plain.accessToken });
    const edited = h.heard(plain, "chat:edited").at(-1)?.payload as { text?: string };
    assert.equal(edited.text, "@everyone now");
  });
});

describe("#channel mentions", () => {
  it("never sends a hidden channel's name to somebody who cannot see it", async () => {
    const h = await harness(boss);
    const stored = await h.send(OPEN, "notes are in #Staff room");
    assert.equal(stored, "notes are in [#channel](channel:staff)");
    const seen = h.heard(low, "chat:new").at(-1)?.payload;
    assert.ok(seen, "the low member did not get the message at all");
    assert.equal(JSON.stringify(seen).includes("Staff room"), false, "the hidden channel's name reached its client");
  });

  it("does not link a channel the sender cannot see", async () => {
    const h = await harness(low);
    assert.equal(await h.send(OPEN, "is there a #Staff room?"), "is there a #Staff room?");
  });

  it("strips a name somebody put in the link label", async () => {
    const h = await harness(boss);
    assert.equal(await h.send(OPEN, "[#Staff room](channel:staff)"), "[#channel](channel:staff)");
  });
});
