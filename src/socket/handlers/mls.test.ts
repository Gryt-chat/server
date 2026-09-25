import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { ClientState } from "ts-mls/dist/src/clientState";
import type { KeyPackage, PrivateKeyPackage } from "ts-mls/dist/src/keyPackage";

import { blockUser, unblockUser } from "../../db/sqlite/blocks";
import { getSqliteDb, initSqlite } from "../../db/sqlite/connection";
import { setContactPrefs } from "../../db/sqlite/contactPrefs";
import { createGroupConversation, openDirectConversation } from "../../db/sqlite/conversations";
import { getMlsGroupForConversation } from "../../db/sqlite/mls";
import { createServerConfigIfNotExists, setServerRole, updateServerConfig } from "../../db/sqlite/servers";
import { setUserModerationState, upsertUser } from "../../db/sqlite/users";
import { mlsRetentionDays, runMlsRetention } from "../../jobs/mlsRetention";
import { parseGroupMessage, parseKeyPackage, parseWelcome } from "../../services/mlsWire";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { refreshClientPermissions } from "../utils/standing";
import { registerMlsHandlers } from "./mls";
import type { EventHandlerMap, HandlerContext } from "./types";

/** Real suite 1 MLS from ts-mls on both ends, so what the server stores and hands
    back is proven to still open, not just to be the same length. */

/* eslint-disable @typescript-eslint/no-require-imports */
const mls = {
  ...(require("ts-mls/clientState.js") as typeof import("ts-mls/dist/src/clientState")),
  ...(require("ts-mls/createCommit.js") as typeof import("ts-mls/dist/src/createCommit")),
  ...(require("ts-mls/createMessage.js") as typeof import("ts-mls/dist/src/createMessage")),
  ...(require("ts-mls/processMessages.js") as typeof import("ts-mls/dist/src/processMessages")),
  ...(require("ts-mls/keyPackage.js") as typeof import("ts-mls/dist/src/keyPackage")),
  ...(require("ts-mls/message.js") as typeof import("ts-mls/dist/src/message")),
  ...(require("ts-mls/crypto/getCiphersuiteImpl.js") as typeof import("ts-mls/dist/src/crypto/getCiphersuiteImpl")),
  ...(require("ts-mls/crypto/ciphersuite.js") as typeof import("ts-mls/dist/src/crypto/ciphersuite")),
  ...(require("ts-mls/defaultCapabilities.js") as typeof import("ts-mls/dist/src/defaultCapabilities")),
  ...(require("ts-mls/lifetime.js") as typeof import("ts-mls/dist/src/lifetime")),
  ...(require("ts-mls/pskIndex.js") as typeof import("ts-mls/dist/src/pskIndex")),
};
/* eslint-enable @typescript-eslint/no-require-imports */

type Impl = Awaited<ReturnType<typeof mls.getCiphersuiteImpl>>;
let impl: Impl;

const HOST = "mls.test:5001";
let dir: string;

interface Reply {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface Participant {
  serverUserId: string;
  grytUserId: string;
  accessToken: string;
  handlers: EventHandlerMap;
  received: (event: string) => Record<string, unknown>[];
  clear: () => void;
  call: (event: string, payload?: Record<string, unknown>) => Promise<Reply>;
}

const clientsInfo: Clients = {};
const sockets = new Map<string, { emit: (event: string, payload?: unknown) => boolean }>();
const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets } };

let seq = 0;
async function connect(nickname: string): Promise<Participant> {
  seq += 1;
  const clientId = `mls-socket-${seq}`;
  const grytUserId = `account-mls-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");

  const emitted: { event: string; payload: unknown }[] = [];
  const emit = (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
    return true;
  };
  sockets.set(clientId, { emit });
  clientsInfo[clientId] = {
    serverUserId: user.server_user_id, grytUserId, nickname, color: "#666666",
    isMuted: false, isDeafened: false, streamID: "", hasJoinedChannel: false, voiceChannelId: "", isAFK: false,
    cameraEnabled: false, cameraStreamID: "", screenShareEnabled: false, screenShareVideoStreamID: "",
    screenShareAudioStreamID: "", isServerMuted: false, isServerDeafened: false,
  } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);

  const ctx = {
    io,
    socket: { id: clientId, handshake: { headers: { host: HOST }, address: "127.0.0.1" }, emit, join() {}, leave() {} },
    clientId,
    serverId: "mls-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.9.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  const handlers = registerMlsHandlers(ctx);
  const accessToken = generateAccessToken({ grytUserId, serverUserId: user.server_user_id, nickname, serverHost: HOST, tokenVersion: 0 });

  return {
    serverUserId: user.server_user_id,
    grytUserId,
    accessToken,
    handlers,
    received: (event) => emitted.filter((e) => e.event === event).map((e) => e.payload as Record<string, unknown>),
    clear: () => {
      emitted.length = 0;
    },
    call: (event, payload = {}) =>
      new Promise<Reply>((resolve) => {
        void handlers[event]({ accessToken, ...payload }, resolve);
      }),
  };
}

/** One device's MLS side, as a client would hold it. */
interface Device {
  id: string;
  packages: { publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }[];
  state?: ClientState;
}

const encodeKp = (kp: KeyPackage) => mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage: kp });

async function makeDevice(id: string, count: number): Promise<Device> {
  const packages = [];
  for (let i = 0; i < count; i++) {
    packages.push(
      await mls.generateKeyPackage(
        { credentialType: "basic", identity: new TextEncoder().encode(id) },
        mls.defaultCapabilities(),
        mls.defaultLifetime,
        [],
        impl,
      ),
    );
  }
  return { id, packages };
}

async function publish(p: Participant, d: Device, lastResort = false): Promise<Reply> {
  const encoded = d.packages.map((k) => encodeKp(k.publicPackage));
  return p.call("mls:keypackages:publish", {
    deviceId: d.id,
    keyPackages: lastResort ? encoded.slice(0, -1) : encoded,
    ...(lastResort ? { lastResort: encoded[encoded.length - 1] } : {}),
  });
}

/* The claimed package's private half, matched by ref as a client matches it. */
async function privateFor(d: Device, claimed: Uint8Array): Promise<Device["packages"][number]> {
  const parsed = await parseKeyPackage(claimed);
  assert.ok(parsed.ok);
  for (const k of d.packages) {
    const mine = await parseKeyPackage(encodeKp(k.publicPackage));
    if (mine.ok && mine.ref === parsed.ref) return k;
  }
  throw new Error("claimed a package this device never made");
}

function decode(bytes: Uint8Array) {
  const [msg] = mls.decodeMlsMessage(bytes, 0)!;
  return msg;
}

async function startGroup(owner: Device): Promise<{ groupIdHex: string }> {
  const groupId = randomBytes(16);
  owner.state = await mls.createGroup(groupId, owner.packages[0].publicPackage, owner.packages[0].privatePackage, [], impl);
  return { groupIdHex: groupId.toString("hex") };
}

async function commitAdding(committer: Device, kps: Uint8Array[]) {
  const extraProposals = kps.map((b) => {
    const m = decode(b);
    assert.equal(m.wireformat, "mls_key_package");
    return { proposalType: "add" as const, add: { keyPackage: (m as { keyPackage: KeyPackage }).keyPackage } };
  });
  const result = await mls.createCommit(
    { state: committer.state!, cipherSuite: impl },
    { extraProposals, wireAsPublicMessage: true, ratchetTreeExtension: true },
  );
  return {
    result,
    commit: mls.encodeMlsMessage(result.commit),
    welcome: result.welcome ? mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome: result.welcome }) : undefined,
  };
}

async function applicationMessage(sender: Device, text: string): Promise<Uint8Array> {
  const r = await mls.createApplicationMessage(sender.state!, new TextEncoder().encode(text), impl);
  sender.state = r.newState;
  return mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_private_message", privateMessage: r.privateMessage });
}

async function receive(d: Device, bytes: Uint8Array): Promise<string | null> {
  const m = decode(bytes);
  if (m.wireformat !== "mls_private_message" && m.wireformat !== "mls_public_message") throw new Error(m.wireformat);
  const r = await mls.processMessage(m, d.state!, mls.emptyPskIndex, () => "accept", impl);
  d.state = r.newState;
  return r.kind === "applicationMessage" ? new TextDecoder().decode(r.message) : null;
}

let alice: Participant;
let bob: Participant;
let mallory: Participant;
let dm: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-mls-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  resetChannelIdCache();
  impl = await mls.getCiphersuiteImpl(mls.getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"));

  alice = await connect("Alice");
  bob = await connect("Bob");
  mallory = await connect("Mallory");
  dm = (await openDirectConversation(alice.serverUserId, bob.serverUserId)).conversation_id;
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the wire parser", () => {
  it("names a Welcome's recipient by the same ref as the KeyPackage it was built from", async () => {
    const a = await makeDevice("wire-a", 1);
    const b = await makeDevice("wire-b", 1);
    await startGroup(a);
    const { commit, welcome } = await commitAdding(a, [encodeKp(b.packages[0].publicPackage)]);

    const kp = await parseKeyPackage(encodeKp(b.packages[0].publicPackage));
    const w = parseWelcome(welcome!);
    const c = await parseGroupMessage(commit);
    assert.ok(kp.ok && w.ok && c.ok);
    assert.deepEqual(w.recipients, [kp.ref]);
    assert.deepEqual([c.kind, c.epoch, c.addedRefs], ["commit", 0, [kp.ref]]);
  });

  it("refuses junk, trailing bytes and another ciphersuite", async () => {
    const good = encodeKp((await makeDevice("wire-c", 1)).packages[0].publicPackage);
    assert.equal((await parseKeyPackage(new Uint8Array([1, 2, 3]))).ok, false);
    assert.equal((await parseKeyPackage(new Uint8Array([...good, 0]))).ok, false, "trailing bytes nobody looked at");

    // MLSMessage header (4 bytes), then the KeyPackage's version (2) and cipher_suite (2).
    const suite2 = new Uint8Array(good);
    suite2[7] = 2;
    const refused = await parseKeyPackage(suite2);
    assert.equal(!refused.ok && refused.error, "unsupported_ciphersuite");
  });

  it("refuses a commit sent as PrivateMessage, since its adds can't be checked", async () => {
    const a = await makeDevice("wire-d", 1);
    await startGroup(a);
    const r = await mls.createCommit({ state: a.state!, cipherSuite: impl }, {});
    const parsed = await parseGroupMessage(mls.encodeMlsMessage(r.commit));
    assert.equal(!parsed.ok && parsed.error, "must_be_public");
  });
});

describe("KeyPackages", () => {
  it("are refused from somebody not signed in", async () => {
    const d = await makeDevice("anon", 1);
    const reply = await new Promise<Reply>((resolve) => {
      void alice.handlers["mls:keypackages:publish"]({ accessToken: "not-a-token", deviceId: d.id, keyPackages: [encodeKp(d.packages[0].publicPackage)] }, resolve);
    });
    assert.equal(reply.error, "unauthenticated");
  });

  it("are refused when they aren't KeyPackages", async () => {
    const reply = await alice.call("mls:keypackages:publish", { deviceId: "junk", keyPackages: [Buffer.from("hello")] });
    assert.equal(reply.error, "invalid_key_package");
  });

  it("stop at five devices per member", async () => {
    const carol = await connect("Carol");
    for (let i = 0; i < 5; i++) {
      assert.equal((await publish(carol, await makeDevice(`carol-${i}`, 1))).ok, true);
    }
    const sixth = await publish(carol, await makeDevice("carol-5", 1));
    assert.equal(sixth.error, "too_many_devices");

    assert.equal((await carol.call("mls:device:remove", { deviceId: "carol-0" })).ok, true);
    assert.equal((await publish(carol, await makeDevice("carol-5", 1))).ok, true, "removing one frees its slot");
  });

  it("are handed out once each, then the last-resort one", async () => {
    const eve = await connect("Eve");
    const frank = await connect("Frank");
    const conv = (await openDirectConversation(eve.serverUserId, frank.serverUserId)).conversation_id;
    const frankPhone = await makeDevice("frank-phone", 3);
    const eveLaptop = await makeDevice("eve-laptop", 1);
    assert.deepEqual(await publish(frank, frankPhone, true), { ok: true, stored: 3, unclaimed: 2, lastResort: true });
    await publish(eve, eveLaptop);

    const refs = [];
    for (let i = 0; i < 4; i++) {
      const r = await eve.call("mls:keypackages:claim", { conversationId: conv, deviceId: "eve-laptop" });
      assert.equal(r.ok, true);
      const [kp] = r.keyPackages as { keyPackage: Buffer; lastResort: boolean }[];
      const parsed = await parseKeyPackage(kp.keyPackage);
      assert.ok(parsed.ok);
      refs.push([parsed.ref, kp.lastResort]);
    }
    assert.notEqual(refs[0][0], refs[1][0], "one package to two groups would share an init key");
    assert.deepEqual(refs.map((r) => r[1]), [false, false, true, true]);
    assert.equal(refs[2][0], refs[3][0]);
  });

  it("are not handed to somebody outside the conversation", async () => {
    await publish(mallory, await makeDevice("mallory-1", 1));
    const r = await mallory.call("mls:keypackages:claim", { conversationId: dm, deviceId: "mallory-1" });
    assert.equal(r.error, "not_found", "the same answer as a conversation that doesn't exist");
  });

  it("follow blocks, contact settings and the server's DM switch", async () => {
    const g = await connect("Gina");
    const h = await connect("Hal");
    const conv = (await openDirectConversation(g.serverUserId, h.serverUserId)).conversation_id;
    await publish(g, await makeDevice("gina-1", 1));
    await publish(h, await makeDevice("hal-1", 3));
    const claim = () => g.call("mls:keypackages:claim", { conversationId: conv, deviceId: "gina-1" });

    await blockUser(h.grytUserId, g.grytUserId);
    assert.equal((await claim()).error, "unknown_member");
    await unblockUser(h.grytUserId, g.grytUserId);

    await setContactPrefs(h.grytUserId, { messages: "nobody", calls: "nobody" });
    assert.equal((await claim()).error, "contact_refused");
    await setContactPrefs(h.grytUserId, { messages: "everyone", calls: "friends" });

    await updateServerConfig({ allowDms: false });
    assert.equal((await claim()).error, "dms_disabled");
    await updateServerConfig({ allowDms: true });

    assert.equal((await claim()).ok, true);
  });

  it("are rate limited, since each claim uses up somebody else's", async () => {
    const i = await connect("Ida");
    const j = await connect("Jon");
    const conv = (await openDirectConversation(i.serverUserId, j.serverUserId)).conversation_id;
    await publish(i, await makeDevice("ida-1", 1));
    await publish(j, await makeDevice("jon-1", 1), true);
    const replies = [];
    for (let n = 0; n < 25; n++) replies.push(await i.call("mls:keypackages:claim", { conversationId: conv, deviceId: "ida-1" }));
    assert.ok(replies.some((r) => r.error === "rate_limited"));
  });
});

describe("a DM over MLS", () => {
  const a1: Device = { id: "alice-laptop", packages: [] };
  const b1: Device = { id: "bob-phone", packages: [] };
  let groupIdHex: string;

  it("starts with the first group registered, and the second told to wait", async () => {
    Object.assign(a1, await makeDevice(a1.id, 2));
    Object.assign(b1, await makeDevice(b1.id, 2));
    await publish(alice, a1);
    await publish(bob, b1);

    ({ groupIdHex } = await startGroup(a1));
    const first = await alice.call("mls:group:create", { conversationId: dm, groupId: groupIdHex });
    const second = await bob.call("mls:group:create", { conversationId: dm, groupId: randomBytes(16).toString("hex") });
    assert.equal(first.ok, true);
    assert.equal(second.error, "group_exists");
    assert.equal((second.group as { groupId: string }).groupId, groupIdHex);
  });

  it("is refused to somebody outside it", async () => {
    assert.equal((await mallory.call("mls:group:create", { conversationId: dm, groupId: "ab" })).error, "not_found");
    assert.equal((await mallory.call("mls:log:fetch", { conversationId: dm, after: 0 })).error, "not_found");
    assert.equal((await mallory.call("mls:devices", { conversationId: dm })).error, "not_found");
  });

  it("adds Bob's phone with a commit and hands it the Welcome", async () => {
    const claim = await alice.call("mls:keypackages:claim", { conversationId: dm, deviceId: a1.id });
    const [kp] = claim.keyPackages as { keyPackage: Buffer; deviceId: string }[];
    assert.equal(kp.deviceId, b1.id);

    bob.clear();
    const { result, commit, welcome } = await commitAdding(a1, [kp.keyPackage]);
    const reply = await alice.call("mls:commit", { conversationId: dm, deviceId: a1.id, commit, welcome });
    assert.deepEqual(reply, { ok: true, seq: 1, epoch: 1 });
    a1.state = result.newState;

    const [pushed] = bob.received("mls:welcome");
    assert.equal(pushed.deviceId, b1.id);
    const sync = await bob.call("mls:sync", { deviceId: b1.id });
    const [waiting] = sync.welcomes as { welcomeId: string; data: Buffer }[];
    assert.equal(waiting.welcomeId, pushed.welcomeId);

    const w = decode(waiting.data);
    if (w.wireformat !== "mls_welcome") throw new Error(w.wireformat);
    const mine = await privateFor(b1, kp.keyPackage);
    b1.state = await mls.joinGroup(w.welcome, mine.publicPackage, mine.privatePackage, mls.emptyPskIndex, impl);

    assert.deepEqual(await bob.call("mls:welcome:ack", { deviceId: b1.id, welcomeIds: [waiting.welcomeId] }), { ok: true, deleted: 1 });
    assert.deepEqual((await bob.call("mls:sync", { deviceId: b1.id })).welcomes, []);
  });

  it("carries a message that still opens on the other side", async () => {
    alice.clear();
    bob.clear();
    const bytes = await applicationMessage(a1, "hello bob");
    const reply = await alice.call("mls:send", { conversationId: dm, deviceId: a1.id, message: bytes });
    assert.deepEqual(reply, { ok: true, seq: 2 });

    const [live] = bob.received("mls:message");
    assert.equal(live.kind, "application");
    assert.equal(await receive(b1, live.data as Buffer), "hello bob");
    assert.equal(alice.received("mls:message").length, 1, "the sender's other sockets see it too");
    assert.equal(bob.received("dm:opened").length, 1, "the first message puts the conversation in Bob's list");
  });

  it("tells the other side about a new device, and lists devices by conversation", async () => {
    alice.clear();
    const b2 = await makeDevice("bob-laptop", 1);
    await publish(bob, b2);
    assert.deepEqual(alice.received("mls:devices:changed"), [{ serverUserId: bob.serverUserId }]);

    const listed = await alice.call("mls:devices", { conversationId: dm });
    const ids = (listed.devices as { deviceId: string }[]).map((d) => d.deviceId).sort();
    assert.deepEqual(ids, ["alice-laptop", "bob-laptop", "bob-phone"]);
    const own = await bob.call("mls:devices");
    assert.equal((own.devices as unknown[]).length, 2);

    const sync = await bob.call("mls:sync", { deviceId: "bob-laptop" });
    assert.deepEqual(sync.keyPackages, { unclaimed: 1, lastResort: false, target: 20 });
    assert.deepEqual((sync.groups as { conversationId: string }[]).map((g) => g.conversationId), [dm]);
    assert.equal((await bob.call("mls:device:remove", { deviceId: "bob-laptop" })).ok, true);
  });

  it("orders two commits racing for one epoch", async () => {
    const [fromAlice, fromBob] = await Promise.all([
      mls.createCommit({ state: a1.state!, cipherSuite: impl }, { wireAsPublicMessage: true }),
      mls.createCommit({ state: b1.state!, cipherSuite: impl }, { wireAsPublicMessage: true }),
    ]);
    const [ra, rb] = await Promise.all([
      alice.call("mls:commit", { conversationId: dm, deviceId: a1.id, commit: mls.encodeMlsMessage(fromAlice.commit) }),
      bob.call("mls:commit", { conversationId: dm, deviceId: b1.id, commit: mls.encodeMlsMessage(fromBob.commit) }),
    ]);

    const replies = [ra, rb];
    assert.equal(replies.filter((r) => r.ok).length, 1, "exactly one commit per epoch");
    const loser = replies.find((r) => !r.ok)!;
    assert.deepEqual([loser.error, loser.epoch], ["stale_epoch", 2]);

    // The loser catches up from its cursor, as a client would, and both agree again.
    const aliceWon = ra.ok;
    const winnerState = aliceWon ? fromAlice.newState : fromBob.newState;
    const behind = aliceWon ? b1 : a1;
    const fetched = await (aliceWon ? bob : alice).call("mls:log:fetch", { conversationId: dm, after: 2 });
    const [entry] = fetched.entries as { kind: string; data: Buffer }[];
    assert.equal(entry.kind, "commit");
    await receive(behind, entry.data);
    if (aliceWon) a1.state = winnerState;
    else b1.state = winnerState;
    assert.equal(a1.state!.groupContext.epoch, b1.state!.groupContext.epoch);

    const retried = await (aliceWon ? bob : alice).call("mls:commit", {
      conversationId: dm,
      deviceId: behind.id,
      commit: mls.encodeMlsMessage((aliceWon ? fromBob : fromAlice).commit),
    });
    assert.equal(retried.error, "stale_epoch", "a commit built on the old epoch stays refused");
  });

  it("refuses a message from an epoch that hasn't happened, and one for another group", async () => {
    const other = await makeDevice("other", 1);
    await startGroup(other);
    const foreign = await applicationMessage(other, "wrong group");
    assert.equal((await alice.call("mls:send", { conversationId: dm, deviceId: a1.id, message: foreign })).error, "wrong_group");

    const commit = await mls.createCommit({ state: a1.state!, cipherSuite: impl }, { wireAsPublicMessage: true });
    const ahead = await applicationMessage({ ...a1, state: commit.newState }, "from the future");
    assert.equal((await alice.call("mls:send", { conversationId: dm, deviceId: a1.id, message: ahead })).error, "future_epoch");
  });

  it("won't add a device that belongs to nobody in the conversation", async () => {
    const outsider = await makeDevice("mallory-2", 1);
    await publish(mallory, outsider);
    const { commit, welcome } = await commitAdding(a1, [encodeKp(outsider.packages[0].publicPackage)]);
    const r = await alice.call("mls:commit", { conversationId: dm, deviceId: a1.id, commit, welcome });
    assert.equal(r.error, "not_a_member_device");
  });

  it("pages the log from a cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await alice.call("mls:send", { conversationId: dm, deviceId: a1.id, message: await applicationMessage(a1, `m${i}`) });
    }
    const first = await bob.call("mls:log:fetch", { conversationId: dm, after: 0, limit: 2 });
    assert.deepEqual((first.entries as { seq: number }[]).map((e) => e.seq), [1, 2]);
    assert.equal(first.hasMore, true);
    const rest = await bob.call("mls:log:fetch", { conversationId: dm, after: first.nextCursor as number, limit: 50 });
    assert.equal(rest.hasMore, false);
    assert.equal(rest.gap, false);
    const all = [...(first.entries as { seq: number }[]), ...(rest.entries as { seq: number }[])].map((e) => e.seq);
    assert.deepEqual(all, all.map((_, i) => i + 1), "no seq skipped, none repeated");
  });

  it("holds back a blocked sender's messages but never a commit", async () => {
    await blockUser(bob.grytUserId, alice.grytUserId);
    bob.clear();
    const head = (getMlsGroupForConversation(dm)!).headSeq;

    await alice.call("mls:send", { conversationId: dm, deviceId: a1.id, message: await applicationMessage(a1, "ignored") });
    const c = await mls.createCommit({ state: a1.state!, cipherSuite: impl }, { wireAsPublicMessage: true });
    const cr = await alice.call("mls:commit", { conversationId: dm, deviceId: a1.id, commit: mls.encodeMlsMessage(c.commit) });
    assert.equal(cr.ok, true);
    a1.state = c.newState;

    assert.deepEqual(bob.received("mls:message").map((m) => m.kind), ["commit"]);
    const fetched = await bob.call("mls:log:fetch", { conversationId: dm, after: head });
    assert.deepEqual((fetched.entries as { kind: string }[]).map((e) => e.kind), ["commit"]);
    assert.equal(fetched.nextCursor, head + 2, "the cursor still moves past what was held back");
    await unblockUser(bob.grytUserId, alice.grytUserId);
  });

  it("refuses a muted member's message, as chat:send does", async () => {
    await setUserModerationState(alice.serverUserId, { muted: true, mutedUntil: new Date(Date.now() + 60_000) });
    const r = await alice.call("mls:send", { conversationId: dm, deviceId: a1.id, message: await applicationMessage(a1, "muted") });
    assert.equal(r.error, "muted");
    await setUserModerationState(alice.serverUserId, { muted: false, mutedUntil: null });
  });

  it("isn't offered for a group DM yet", async () => {
    const group = await createGroupConversation(alice.serverUserId, [bob.serverUserId, mallory.serverUserId]);
    const r = await alice.call("mls:group:create", { conversationId: group.conversation_id, groupId: "cd" });
    assert.equal(r.error, "not_supported");
  });
});

describe("retention", () => {
  it("is 30 days, and a host can only make it shorter", () => {
    assert.equal(mlsRetentionDays({}), 30);
    assert.equal(mlsRetentionDays({ MLS_RETENTION_DAYS: "7" }), 7);
    assert.equal(mlsRetentionDays({ MLS_RETENTION_DAYS: "90" }), 30);
    assert.equal(mlsRetentionDays({ MLS_RETENTION_DAYS: "0" }), 30);
    assert.equal(mlsRetentionDays({ MLS_RETENTION_DAYS: "soon" }), 30);
  });

  it("sweeps old ciphertext, and a device behind it is told it has a gap", async () => {
    const group = getMlsGroupForConversation(dm)!;
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    getSqliteDb().prepare(`UPDATE mls_log SET created_at = ? WHERE group_id = ? AND seq <= 3`).run(old, group.groupId);

    process.env.MLS_RETENTION_DAYS = "7";
    try {
      assert.ok(runMlsRetention().log >= 3);
    } finally {
      delete process.env.MLS_RETENTION_DAYS;
    }

    const behind = await bob.call("mls:log:fetch", { conversationId: dm, after: 1 });
    assert.equal(behind.gap, true);
    assert.equal((behind.entries as { seq: number }[])[0].seq, 4);
    const caughtUp = await bob.call("mls:log:fetch", { conversationId: dm, after: 3 });
    assert.equal(caughtUp.gap, false);
  });
});
