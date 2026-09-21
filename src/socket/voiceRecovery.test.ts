import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Server } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import { WebSocketServer, type WebSocket } from "ws";

import { upsertServerChannel } from "../db/sqlite/channels";
import { initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { SFUClient } from "../sfu/client";
import { generateAccessToken } from "../utils/jwt";
import { resetRateLimits } from "../utils/rateLimiter";
import { getServerIdFromEnv } from "../utils/serverId";
import { setupSFUSync, socketHandler } from "./index";
import { resetChannelIdCache } from "./utils/conversationAccess";
import { sfuRoomId } from "./utils/voiceRooms";
import { clearVoiceRecoveryGrace, forgetStashedVoiceState } from "./utils/voiceStash";

/**
 * A real socket.io server, real clients and the real SFU client, against a fake
 * SFU control socket where the test decides when a peer comes and goes.
 */

interface Account {
  grytUserId: string;
  serverUserId: string;
  nickname: string;
}

interface Received {
  event: string;
  payload: unknown;
  at: number;
}

interface Member {
  account: Account;
  socket: ClientSocket;
  received: Received[];
}

interface FakeSfu {
  port: number;
  join(roomId: string, userId: string): void;
  leave(roomId: string, userId: string): void;
  /** A sync_response now, rather than on the SFU client's two-second timer. */
  sync(): void;
  close(): Promise<void>;
}

interface Harness {
  io: Server;
  url: string;
  host: string;
  sfu: FakeSfu;
  sfuClient: SFUClient;
  members: Member[];
}

type PublicClients = Record<string, { serverUserId: string; hasJoinedChannel: boolean; voiceChannelId: string }>;

const ENV_KEYS = ["DATA_DIR", "SERVER_NAME", "PORT", "SERVER_INSTANCE_ID", "NODE_ENV", "VOICE_MAX_USERS"];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let dir: string;
let alice: Account;
let bob: Account;
let carol: Account;
let h: Harness;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(20);
  }
}

async function startFakeSfu(): Promise<FakeSfu> {
  const rooms = new Map<string, Set<string>>();
  let control: WebSocket | null = null;
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  const send = (event: string, data: unknown) => {
    control?.send(JSON.stringify({ event, data: JSON.stringify(data) }));
  };
  const sync = () => {
    const list = [...rooms].map(([room_id, users]) => ({ room_id, user_ids: [...users] }));
    send("sync_response", { rooms: list });
  };
  const leave = (roomId: string, userId: string) => {
    rooms.get(roomId)?.delete(userId);
    send("peer_left", { room_id: roomId, user_id: userId });
  };

  wss.on("connection", (ws) => {
    control = ws;
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { event: string; data: string };
      const data = JSON.parse(message.data) as { room_id?: string; user_id?: string };
      if (message.event === "server_register" && data.room_id && !rooms.has(data.room_id)) {
        rooms.set(data.room_id, new Set());
      } else if (message.event === "sync_request") {
        sync();
      } else if (message.event === "disconnect_user" && data.room_id && data.user_id) {
        leave(data.room_id, data.user_id);
      }
    });
  });

  return {
    port: (wss.address() as AddressInfo).port,
    join(roomId, userId) {
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId)?.add(userId);
      send("peer_joined", { room_id: roomId, user_id: userId });
    },
    leave,
    sync,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

async function startServer(): Promise<Harness> {
  const sfu = await startFakeSfu();
  const http = createServer();
  const io = new Server(http);
  const sfuClient = new SFUClient(getServerIdFromEnv(), "voice-recovery-secret", `ws://127.0.0.1:${sfu.port}`);
  setupSFUSync(io, sfuClient);
  await sfuClient.connect();
  io.on("connection", (socket) => socketHandler(io, socket, sfuClient));

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const { port } = http.address() as AddressInfo;
  return { io, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, sfu, sfuClient, members: [] };
}

/** A socket that restores its session, as every app does on connect. */
async function connect(account: Account): Promise<Member> {
  const socket = connectSocket(h.url, { transports: ["websocket"], forceNew: true, reconnection: false });
  const member: Member = { account, socket, received: [] };
  h.members.push(member);

  socket.onAny((event: string, payload: unknown) => {
    member.received.push({ event, payload, at: Date.now() });
  });
  socket.on("connect", () => {
    const accessToken = generateAccessToken({ ...account, serverHost: h.host, tokenVersion: 0 });
    socket.emit("session:restore", { accessToken });
  });

  await waitFor(() => Boolean(socket.id) && latestClients(member)[socket.id ?? ""] !== undefined, "session restored");
  return member;
}

function latestClients(member: Member): PublicClients {
  const last = member.received.filter((r) => r.event === "server:clients").at(-1);
  return (last?.payload ?? {}) as PublicClients;
}

/** The channel `watcher` is shown `who` in, or null. */
function shownIn(watcher: Member, who: Account): string | null {
  const entry = Object.values(latestClients(watcher)).find(
    (c) => c.serverUserId === who.serverUserId && c.hasJoinedChannel,
  );
  return entry ? entry.voiceChannelId : null;
}

function receivedSince(member: Member, mark: number, event: string): Received[] {
  return member.received.slice(mark).filter((r) => r.event === event);
}

function room(channelId: string): string {
  return sfuRoomId(getServerIdFromEnv(), channelId);
}

async function requestRoom(member: Member, channelId: string): Promise<Received> {
  const mark = member.received.length;
  member.socket.emit("voice:room:request", channelId);
  await waitFor(
    () => member.received.slice(mark).some((r) => r.event === "voice:room:granted" || r.event === "voice:room:error"),
    `an answer to ${member.account.nickname}'s room request`,
  );
  return member.received.slice(mark).find((r) => r.event === "voice:room:granted" || r.event === "voice:room:error")!;
}

/** What @gryt/voice sends after the SFU has the peer: the stream, then the join. */
function announce(member: Member, streamId: string): void {
  member.socket.emit("voice:stream:set", streamId);
  member.socket.emit("voice:channel:joined", true);
}

/** Joins and waits for a sync to confirm it, which ends the join's own grace. */
async function joinVoice(member: Member, channelId: string, streamId: string): Promise<void> {
  const answer = await requestRoom(member, channelId);
  assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
  h.sfu.join(room(channelId), member.account.serverUserId);
  announce(member, streamId);
  const watcher = h.members[0];
  await waitFor(() => shownIn(watcher, member.account) === channelId, `${member.account.nickname} in ${channelId}`);
  await syncNow();
}

async function syncNow(): Promise<void> {
  h.sfu.sync();
  await sleep(150);
}

/** As if they had been in the call a minute, past the ten seconds after a join
    in which peer_left used to be ignored. */
function ageTracker(account: Account): void {
  const tracked = h.sfuClient.getTrackedUser(account.serverUserId);
  assert.ok(tracked, `${account.nickname} should hold a seat`);
  tracked.connectedAt -= 60_000;
}

async function closeSocket(member: Member): Promise<void> {
  const id = member.socket.id ?? "";
  member.socket.disconnect();
  await waitFor(() => !h.io.sockets.sockets.has(id), "the server to see the socket go");
}

function holdsSeat(account: Account): boolean {
  return h.sfuClient.getActiveUsers().has(account.serverUserId);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-voice-recovery-"));
  process.env.DATA_DIR = dir;
  process.env.SERVER_NAME = "voice_recovery";
  process.env.PORT = "5999";
  process.env.SERVER_INSTANCE_ID = "test";
  // Otherwise socketHandler logs every event it sends and receives.
  process.env.NODE_ENV = "production";
  await initSqlite();
  await createServerConfigIfNotExists();

  const make = async (grytUserId: string, nickname: string): Promise<Account> => {
    const user = await upsertUser(grytUserId, nickname);
    await setServerRole(user.server_user_id, "member");
    return { grytUserId, serverUserId: user.server_user_id, nickname };
  };
  alice = await make("account-alice", "Alice");
  bob = await make("account-bob", "Bob");
  carol = await make("account-carol", "Carol");

  await upsertServerChannel({ channelId: "voice", name: "Voice", type: "voice" });
  await upsertServerChannel({ channelId: "voice2", name: "Voice Two", type: "voice" });
  resetChannelIdCache();
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetRateLimits();
  h = await startServer();
});

afterEach(async () => {
  for (const member of h.members) member.socket.disconnect();
  await waitFor(() => h.io.sockets.sockets.size === 0, "every socket to close");
  for (const account of [alice, bob, carol]) forgetStashedVoiceState(account.serverUserId);
  h.sfuClient.disconnect();
  h.io.close();
  await h.sfu.close();
  delete process.env.VOICE_MAX_USERS;
});

describe("a reload in the middle of a call", () => {
  it("plays the leave and frees the seat at once when the socket closes first", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    const mark = watcher.received.length;
    await closeSocket(laptop);
    const leftAt = Date.now();
    h.sfu.leave(room("voice"), alice.serverUserId);

    await waitFor(() => receivedSince(watcher, mark, "voice:peer:left").length > 0, "the leave");
    const [chime] = receivedSince(watcher, mark, "voice:peer:left");
    assert.ok(chime.at - leftAt < 1000, `the leave came ${chime.at - leftAt}ms after the SFU said so`);
    assert.equal(holdsSeat(alice), false);
  });

  it("plays the leave and frees the seat at once when the SFU notices first", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    const mark = watcher.received.length;
    h.sfu.leave(room("voice"), alice.serverUserId);
    await sleep(100);
    await closeSocket(laptop);
    const closedAt = Date.now();

    await waitFor(() => receivedSince(watcher, mark, "voice:peer:left").length > 0, "the leave");
    const [chime] = receivedSince(watcher, mark, "voice:peer:left");
    assert.ok(chime.at - closedAt < 1000, `the leave came ${chime.at - closedAt}ms after the socket closed`);
    await waitFor(() => !holdsSeat(alice), "the seat to be freed", 1000);
  });

  it("does not put the reloaded app back in voice", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    await closeSocket(laptop);
    await sleep(100);
    h.sfu.leave(room("voice"), alice.serverUserId);

    const reloaded = await connect(alice);
    await syncNow();
    await syncNow();

    assert.equal(receivedSince(reloaded, 0, "voice:state:restored").length, 0);
    assert.equal(shownIn(watcher, alice), null);
  });

  it("lets the next person take the seat at once", async () => {
    process.env.VOICE_MAX_USERS = "2";
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    await closeSocket(laptop);
    await sleep(100);
    h.sfu.leave(room("voice"), alice.serverUserId);
    await sleep(100);

    const next = await connect(carol);
    const answer = await requestRoom(next, "voice");
    assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
  });
});

describe("a signalling blip", () => {
  /** The socket goes, the media carries on, and the app comes back and re-announces. */
  async function blip(laptop: Member): Promise<Member> {
    await closeSocket(laptop);
    await syncNow();
    const back = await connect(alice);
    const answer = await requestRoom(back, "voice");
    assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
    announce(back, "stream-alice");
    return back;
  }

  it("puts somebody back in voice without a chime when they re-announce", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    const mark = watcher.received.length;
    const back = await blip(laptop);
    await waitFor(() => shownIn(watcher, alice) === "voice", "Alice back in voice");
    await syncNow();

    assert.equal(receivedSince(back, 0, "voice:state:restored").length, 1);
    assert.equal(receivedSince(back, 0, "voice:room:leave").length, 0);
    assert.equal(receivedSince(watcher, mark, "voice:peer:left").length, 0);
    assert.equal(receivedSince(watcher, mark, "voice:peer:joined").length, 0);
    assert.equal(shownIn(watcher, alice), "voice");
  });

  it("lets the re-announce through on a full server", async () => {
    process.env.VOICE_MAX_USERS = "2";
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    await blip(laptop);
    await waitFor(() => shownIn(watcher, alice) === "voice", "Alice back in voice");
  });

  it("puts back an app that reconnects without re-announcing", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    const mark = watcher.received.length;
    await closeSocket(laptop);
    const back = await connect(alice);
    await syncNow();

    await waitFor(() => shownIn(watcher, alice) === "voice", "Alice back in voice");
    await waitFor(() => receivedSince(back, 0, "voice:state:restored").length > 0, "the restore");
    assert.equal(receivedSince(back, 0, "voice:state:restored").length, 1);
    assert.equal(receivedSince(watcher, mark, "voice:peer:left").length, 0);
  });

  it("keeps a rejoin in voice while the SFU catches up", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    // Both halves drop. The app is back before the SFU notices, and reconnects its media.
    const mark = watcher.received.length;
    await closeSocket(laptop);
    const back = await connect(alice);
    h.sfu.leave(room("voice"), alice.serverUserId);
    const answer = await requestRoom(back, "voice");
    assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
    await syncNow();
    await syncNow();
    h.sfu.join(room("voice"), alice.serverUserId);
    announce(back, "stream-alice-2");
    await syncNow();

    await waitFor(() => shownIn(watcher, alice) === "voice", "Alice in voice");
    assert.equal(receivedSince(back, 0, "voice:room:leave").length, 0);
    assert.equal(receivedSince(watcher, mark, "voice:peer:left").length, 0);
  });
});

describe("a second device", () => {
  it("does not hand the call to a phone that was already connected", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const phone = await connect(alice);
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    await closeSocket(laptop);
    await syncNow();
    assert.equal(receivedSince(phone, 0, "voice:state:restored").length, 0);
    assert.equal(shownIn(watcher, alice), null);

    const back = await connect(alice);
    const answer = await requestRoom(back, "voice");
    assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
    announce(back, "stream-alice");
    await waitFor(() => shownIn(watcher, alice) === "voice", "Alice back in voice");
    assert.equal(receivedSince(phone, 0, "voice:device:disconnect").length, 0);
  });

  it("still plays the leave at once when the laptop quits and the phone stays", async () => {
    process.env.VOICE_MAX_USERS = "2";
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    await connect(alice);
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");

    const mark = watcher.received.length;
    await closeSocket(laptop);
    await sleep(100);
    const leftAt = Date.now();
    h.sfu.leave(room("voice"), alice.serverUserId);

    await waitFor(() => receivedSince(watcher, mark, "voice:peer:left").length > 0, "the leave");
    const [chime] = receivedSince(watcher, mark, "voice:peer:left");
    assert.ok(chime.at - leftAt < 1000, `the leave came ${chime.at - leftAt}ms after the SFU said so`);
    const answer = await requestRoom(await connect(carol), "voice");
    assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
  });
});

describe("switching channels on the same server", () => {
  const dropped = (member: Member, mark: number) =>
    receivedSince(member, mark, "voice:room:leave").length +
    receivedSince(member, mark, "voice:channel:joined").filter((r) => r.payload === false).length +
    receivedSince(member, mark, "voice:stream:set").filter((r) => r.payload === "").length;

  it("survives the old room's peer_left arriving before the new request", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice2", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");
    ageTracker(alice);

    const mark = laptop.received.length;
    h.sfu.leave(room("voice"), alice.serverUserId);
    await sleep(150);
    const answer = await requestRoom(laptop, "voice2");
    assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
    await syncNow();
    h.sfu.join(room("voice2"), alice.serverUserId);
    announce(laptop, "stream-alice-2");
    await syncNow();

    await waitFor(() => shownIn(watcher, alice) === "voice2", "Alice in voice2");
    assert.equal(dropped(laptop, mark), 0);
  });

  it("survives the old room's peer_left arriving after the new request", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice2", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");
    ageTracker(alice);

    const mark = laptop.received.length;
    const answer = await requestRoom(laptop, "voice2");
    assert.equal(answer.event, "voice:room:granted", JSON.stringify(answer.payload));
    h.sfu.leave(room("voice"), alice.serverUserId);
    await syncNow();
    h.sfu.join(room("voice2"), alice.serverUserId);
    announce(laptop, "stream-alice-2");
    await syncNow();

    await waitFor(() => shownIn(watcher, alice) === "voice2", "Alice in voice2");
    assert.equal(dropped(laptop, mark), 0);
  });
});

describe("media that never comes back", () => {
  it("takes a connected socket out of voice once the grace runs out", async () => {
    const watcher = await connect(bob);
    await joinVoice(watcher, "voice", "stream-bob");
    const laptop = await connect(alice);
    await joinVoice(laptop, "voice", "stream-alice");
    ageTracker(alice);

    const mark = watcher.received.length;
    h.sfu.leave(room("voice"), alice.serverUserId);
    await syncNow();
    clearVoiceRecoveryGrace(alice.serverUserId);
    await syncNow();

    await waitFor(() => receivedSince(laptop, 0, "voice:room:leave").length > 0, "Alice taken out");
    await waitFor(() => receivedSince(watcher, mark, "voice:peer:left").length > 0, "the leave");
    await waitFor(() => shownIn(watcher, alice) === null, "Alice gone from voice");
  });
});
