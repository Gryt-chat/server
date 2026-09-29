import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { resetRateLimits } from "../../utils/rateLimiter";
import { broadcastMemberList } from "../utils/clients";
import { refreshClientPermissions } from "../utils/standing";
import { registerMemberHandlers } from "./members";
import type { HandlerContext } from "./types";

/** `profile:update` with the card fields, through to both copies of the member
    list: the broadcast, which has a dedupe hash, and `members:fetch`. */

let dir: string;
const clientsInfo: Clients = {};
const sockets = new Map<string, { emit: (event: string, payload?: unknown) => boolean }>();
const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets } };

interface Member {
  serverUserId: string;
  received: (event: string) => unknown[];
  update: (data: Record<string, unknown>) => Promise<void>;
  fetchMembers: () => Promise<void>;
}

let seq = 0;
async function connect(nickname: string, permissions?: Permission[]): Promise<Member> {
  seq += 1;
  const clientId = `card-socket-${seq}`;
  const user = await upsertUser(`account-card-${seq}`, nickname);
  if (permissions) {
    await createRoleDefinition(`card-role-${seq}`, { name: `Card ${seq}`, rank: 50, permissions });
    await setServerRole(user.server_user_id, `card-role-${seq}`);
  } else {
    await setServerRole(user.server_user_id, "member");
  }

  const emitted: { event: string; payload: unknown }[] = [];
  const emit = (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
    return true;
  };
  sockets.set(clientId, { emit });
  clientsInfo[clientId] = {
    serverUserId: user.server_user_id, grytUserId: `account-card-${seq}`, nickname, color: "#666666",
    isMuted: false, isDeafened: false, streamID: "", hasJoinedChannel: false, voiceChannelId: "", isAFK: false,
    cameraEnabled: false, cameraStreamID: "", screenShareEnabled: false, screenShareVideoStreamID: "",
    screenShareAudioStreamID: "", isServerMuted: false, isServerDeafened: false,
  } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);

  const ctx = {
    io,
    socket: { id: clientId, handshake: { headers: { host: "card.test" }, address: "127.0.0.1" }, emit, join() {}, leave() {} },
    clientId,
    serverId: "card-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.9.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  const handlers = registerMemberHandlers(ctx);

  return {
    serverUserId: user.server_user_id,
    received: (event) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    update: async (data) => {
      await handlers["profile:update"](data);
    },
    fetchMembers: async () => {
      await handlers["members:fetch"]();
    },
  };
}

type Row = { serverUserId: string; cardStyle?: unknown; bio?: unknown; pronouns?: unknown; statusLine?: unknown };
const rowOf = (list: unknown, m: Member) => (list as Row[]).find((r) => r.serverUserId === m.serverUserId);

async function waitFor<T>(read: () => T | undefined, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-card-handler-"));
  process.env.DATA_DIR = dir;
  process.env.JWT_SECRET = "test-secret";
  await initSqlite();
  await createServerConfigIfNotExists();
});

beforeEach(() => resetRateLimits());

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("profile:update with a card", () => {
  it("reaches both copies of the member list", async () => {
    const alice = await connect("Alice");
    const bob = await connect("Bob");
    // Settle first, so the only thing left to move the dedupe hash is the card.
    broadcastMemberList(io as never, clientsInfo, "card-test");
    await waitFor(() => bob.received("members:list").find((l) => rowOf(l, alice)));
    const before = bob.received("members:list").length;

    await alice.update({
      cardStyle: { fill: "gradient", c1: "#FFD400", c2: "#3355aa", angle: 90, pattern: "dots" },
      bio: "Plays bass badly",
      pronouns: "she/her",
      statusLine: "back at six",
    });
    const want = {
      cardStyle: { fill: "gradient", c1: "#ffd400", c2: "#3355aa", angle: 90, pattern: "dots" },
      bio: "Plays bass badly",
      pronouns: "she/her",
      statusLine: "back at six",
    };

    const broadcast = await waitFor(() =>
      bob.received("members:list").slice(before).map((l) => rowOf(l, alice)).find((r) => r?.bio),
    );
    assert.deepEqual(
      { cardStyle: broadcast.cardStyle, bio: broadcast.bio, pronouns: broadcast.pronouns, statusLine: broadcast.statusLine },
      want,
    );

    await bob.fetchMembers();
    const fetched = rowOf(bob.received("members:list").at(-1), alice);
    assert.deepEqual(
      { cardStyle: fetched?.cardStyle, bio: fetched?.bio, pronouns: fetched?.pronouns, statusLine: fetched?.statusLine },
      want,
    );
  });

  it("hands the cleaned card back to the member who set it", async () => {
    const m = await connect("Carol");
    await m.update({ cardStyle: { fill: "solid", c1: "abcdef", junk: 1 }, pronouns: " they/‮them " });
    const reply = m.received("profile:updated").at(-1) as Row;
    assert.deepEqual(reply.cardStyle, { fill: "solid", c1: "#abcdef" });
    assert.equal(reply.pronouns, "they/ them");
    assert.equal(reply.bio, null);
  });

  it("drops a bad style to the default instead of refusing the update", async () => {
    const m = await connect("Dan");
    await m.update({ cardStyle: { fill: "plaid", c1: "red" }, bio: "still here" });
    const stored = await getUserByServerId(m.serverUserId);
    assert.equal(stored?.card_style, null);
    assert.equal(stored?.bio, "still here");
    assert.equal(m.received("profile:error").length, 0);
  });

  it("leaves the card alone on an update about something else", async () => {
    const m = await connect("Erin");
    await m.update({ bio: "kept", statusLine: "kept too" });
    await m.update({ nickname: "Erin two" });
    await m.update({});
    const stored = await getUserByServerId(m.serverUserId);
    assert.equal(stored?.bio, "kept");
    assert.equal(stored?.status_line, "kept too");
  });

  it("clears a field sent as null or empty", async () => {
    const m = await connect("Finn");
    await m.update({ cardStyle: { pattern: "weave" }, bio: "gone soon", pronouns: "he/him" });
    await m.update({ cardStyle: null, bio: "", pronouns: null });
    const stored = await getUserByServerId(m.serverUserId);
    assert.equal(stored?.card_style, null);
    assert.equal(stored?.bio, null);
    assert.equal(stored?.pronouns, null);
  });

  it("needs set_activity for text, and nothing for a clear or a style", async () => {
    const m = await connect("Gus", ["send_messages"]);
    await m.update({ bio: "hello", cardStyle: { pattern: "dots" } });
    assert.equal(m.received("profile:error").length, 1);
    assert.equal((await getUserByServerId(m.serverUserId))?.card_style, null, "nothing is written on a refusal");

    await m.update({ cardStyle: { pattern: "dots" }, bio: "" });
    assert.equal(m.received("profile:error").length, 1);
    assert.equal((await getUserByServerId(m.serverUserId))?.card_style, '{"pattern":"dots"}');
  });

  it("is rate limited like a status", async () => {
    const m = await connect("Hana");
    for (let i = 0; i < 12; i++) await m.update({ statusLine: `take ${i}` });
    const limited = (m.received("server:error") as { error?: string }[]).filter((e) => e.error === "rate_limited");
    assert.ok(limited.length > 0);
  });
});
