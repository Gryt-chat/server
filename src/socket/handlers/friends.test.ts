import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite, getSqliteDb } from "../../db/sqlite/connection";
import { directConversationId, openDirectConversation } from "../../db/sqlite/conversations";
import { areFriends } from "../../db/sqlite/friends";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { replaceUserIdentity, setUserModerationState, upsertUser } from "../../db/sqlite/users";
import { spamFilter } from "../../moderation/spamFilter";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import { resetRings } from "../utils/callRings";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { refreshClientPermissions } from "../utils/standing";
import { registerBlockHandlers } from "./blocks";
import { registerCallHandlers } from "./calls";
import { registerChatHandlers } from "./chat";
import { registerContactPrefsHandlers } from "./contactPrefs";
import { registerDirectMessageHandlers } from "./dm";
import { registerFriendHandlers } from "./friends";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * GRYT-1471: every friend request transition, and how blocks and the contact
 * settings bend them, asked of the handlers a real socket reaches.
 */

const HOST = "friends.test:5001";

interface ListView {
  friends: { serverUserId: string }[];
  incoming: { serverUserId: string }[];
  outgoing: { serverUserId: string }[];
}

interface Member {
  clientId: string;
  serverUserId: string;
  grytUserId: string;
  nickname: string;
  accessToken: string;
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
  clear: () => void;
}

let dir: string;
const clientsInfo: Clients = {};
const sockets = new Map<string, { emit: (event: string, payload?: unknown) => boolean }>();
const io = {
  to() {
    return { emit() {} };
  },
  emit() {},
  sockets: { sockets },
} as unknown as HandlerContext["io"];

let seq = 0;

async function connect(nickname: string, grytUserId = `account-friends-${seq + 1}`): Promise<Member> {
  seq += 1;
  const clientId = `friends-${seq}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");

  const emitted: { event: string; payload: unknown }[] = [];
  const record = (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
    return true;
  };
  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: record,
    join() {},
    leave() {},
    to() {
      return { emit() {} };
    },
  };
  sockets.set(clientId, { emit: record });
  clientsInfo[clientId] = {
    serverUserId: user.server_user_id,
    grytUserId,
    nickname,
    color: "#666666",
    hasJoinedChannel: false,
    voiceChannelId: "",
  } as Clients[string];
  await refreshClientPermissions(clientsInfo, clientId);

  const ctx = {
    io,
    socket,
    clientId,
    serverId: "friends-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.4.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    clientId,
    serverUserId: user.server_user_id,
    grytUserId,
    nickname,
    accessToken: generateAccessToken({ grytUserId, serverUserId: user.server_user_id, nickname, serverHost: HOST, tokenVersion: 0 }),
    handlers: {
      ...registerFriendHandlers(ctx),
      ...registerBlockHandlers(ctx),
      ...registerContactPrefsHandlers(ctx),
      ...registerChatHandlers(ctx),
      ...registerDirectMessageHandlers(ctx),
      ...registerCallHandlers(ctx),
    },
    received: (event) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    clear: () => {
      emitted.length = 0;
    },
  };
}

const act = (event: string) => async (from: Member, to: Member) => {
  await from.handlers[event]({ accessToken: from.accessToken, serverUserId: to.serverUserId });
};
const request = act("friend:request");
const accept = act("friend:accept");
const decline = act("friend:decline");
const cancel = act("friend:cancel");
const remove = act("friend:remove");

/** The newest list this member was sent, asking for one if nothing came. */
async function listOf(who: Member): Promise<ListView> {
  let all = who.received("friend:list");
  if (all.length === 0) {
    await who.handlers["friend:list"]({ accessToken: who.accessToken });
    all = who.received("friend:list");
  }
  return all[all.length - 1] as ListView;
}

const ids = (people: { serverUserId: string }[]) => people.map((p) => p.serverUserId);

function lastError(who: Member): { error?: string; reason?: string } | undefined {
  const all = who.received("friend:error");
  return all[all.length - 1] as { error?: string; reason?: string } | undefined;
}

async function choose(who: Member, messages: string, calls: string): Promise<void> {
  await who.handlers["contact:prefs:set"]({ accessToken: who.accessToken, messages, calls });
}

function clearAll(...members: Member[]) {
  for (const m of members) m.clear();
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-friends-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  resetChannelIdCache();
});

beforeEach(() => {
  resetRateLimits();
  resetRings();
  spamFilter.reset();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a request", () => {
  it("reaches the other person once, and shows as outgoing for the sender", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);

    assert.deepEqual(ids((await listOf(a)).outgoing), [b.serverUserId]);
    assert.deepEqual(ids((await listOf(b)).incoming), [a.serverUserId]);
    assert.deepEqual(b.received("friend:request:incoming"), [{ serverUserId: a.serverUserId, nickname: "Ada" }]);

    clearAll(a, b);
    await request(a, b);
    assert.equal(b.received("friend:request:incoming").length, 0, "asking again doesn't notify again");
  });

  it("accepted, makes them friends and clears the request", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    clearAll(a, b);
    await accept(b, a);

    assert.ok(await areFriends(a.grytUserId, b.grytUserId));
    for (const [who, other] of [[a, b], [b, a]] as const) {
      const list = await listOf(who);
      assert.deepEqual(ids(list.friends), [other.serverUserId]);
      assert.equal(list.incoming.length + list.outgoing.length, 0);
    }
  });

  it("sent both ways is a yes", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    await request(b, a);
    assert.ok(await areFriends(a.grytUserId, b.grytUserId));
  });

  it("can't be accepted when nobody asked", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await accept(b, a);
    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);
  });

  it("declined, leaves the recipient's list and stays pending on the sender's side", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    await decline(b, a);
    clearAll(a, b);

    assert.deepEqual((await listOf(b)).incoming, []);
    assert.deepEqual(ids((await listOf(a)).outgoing), [b.serverUserId]);

    await request(a, b);
    assert.equal(b.received("friend:request:incoming").length, 0, "asking again after a decline is silent");
    assert.deepEqual((await listOf(b)).incoming, []);
  });

  it("cancelled, is gone for both", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    clearAll(a, b);
    await cancel(a, b);

    assert.deepEqual((await listOf(a)).outgoing, []);
    assert.deepEqual((await listOf(b)).incoming, []);
    await accept(b, a);
    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);
  });

  it("goes after thirty days", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    getSqliteDb().prepare(`UPDATE friend_requests SET created_at = ? WHERE from_gryt_user_id = ?`).run(old, a.grytUserId);
    clearAll(a, b);

    assert.deepEqual((await listOf(b)).incoming, []);
    await accept(b, a);
    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);
  });

  it("refuses yourself, a bot, and somebody who isn't here", async () => {
    const a = await connect("Ada");
    const bot = await connect("Botty", `BOT_friends-${seq + 1}`);
    await request(a, a);
    assert.equal(lastError(a)?.error, "unknown_member");
    await request(a, bot);
    assert.equal(lastError(a)?.error, "unknown_member");
    await a.handlers["friend:request"]({ accessToken: a.accessToken, serverUserId: "nobody-here" });
    assert.equal(lastError(a)?.error, "unknown_member");
  });
});

describe("removing a friend", () => {
  it("ends it for both and tells each of them", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    await accept(b, a);
    clearAll(a, b);
    await remove(a, b);

    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);
    assert.deepEqual((await listOf(a)).friends, []);
    assert.deepEqual((await listOf(b)).friends, []);
  });
});

describe("blocks", () => {
  it("end the friendship and any request, either way", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    const c = await connect("Cy");
    await request(a, b);
    await accept(b, a);
    await request(c, a);

    await a.handlers["user:block"]({ accessToken: a.accessToken, serverUserId: b.serverUserId });
    await a.handlers["user:block"]({ accessToken: a.accessToken, serverUserId: c.serverUserId });
    clearAll(a, b, c);

    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);
    assert.deepEqual(await listOf(a), { friends: [], incoming: [], outgoing: [] });
    assert.deepEqual((await listOf(c)).outgoing, []);
  });

  it("hide a request from the blocked person without telling them", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await choose(a, "nobody", "nobody");
    await a.handlers["user:block"]({ accessToken: a.accessToken, serverUserId: b.serverUserId });
    clearAll(a, b);

    await request(b, a);
    assert.equal(lastError(b), undefined, "no refusal, so the block can't be read off it");
    assert.deepEqual(ids((await listOf(b)).outgoing), [a.serverUserId]);
    assert.equal(a.received("friend:request:incoming").length, 0);
    assert.deepEqual((await listOf(a)).incoming, []);

    await accept(a, b);
    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);

    await a.handlers["user:unblock"]({ accessToken: a.accessToken, serverUserId: b.serverUserId });
    clearAll(a, b);
    assert.deepEqual((await listOf(a)).incoming, [], "unblocking doesn't bring it back");
    await choose(a, "everyone", "friends");
  });

  it("stop the blocked person asking back to become friends", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    await b.handlers["user:block"]({ accessToken: b.accessToken, serverUserId: a.serverUserId });
    await request(a, b);
    await request(b, a);
    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);
  });
});

describe("contact settings", () => {
  it("messages from nobody shuts friend requests too", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await choose(b, "nobody", "nobody");
    await request(a, b);

    assert.equal(lastError(a)?.error, "contact_refused");
    assert.equal(b.received("friend:request:incoming").length, 0);
    assert.deepEqual((await listOf(a)).outgoing, []);
  });

  it("but they can still ask, and the answer is a yes", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await choose(b, "nobody", "nobody");
    await request(b, a);
    await accept(a, b);
    assert.ok(await areFriends(a.grytUserId, b.grytUserId));
  });

  it("messages from friends still lets a request in, or nobody could become one", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await choose(b, "friends", "friends");
    await request(a, b);
    assert.equal(lastError(a), undefined);
    assert.deepEqual(ids((await listOf(b)).incoming), [a.serverUserId]);
  });

  it("a muted member can't send one", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await setUserModerationState(a.serverUserId, { muted: true, mutedUntil: new Date(Date.now() + 60_000) });
    await request(a, b);
    assert.equal(lastError(a)?.error, "muted");
    assert.deepEqual((await listOf(b)).incoming, []);
  });
});

describe("a flood of requests", () => {
  it("earns the spam filter's timeout, and stops arriving", async () => {
    const spammer = await connect("Spam");
    const targets: Member[] = [];
    for (let i = 0; i < 8; i++) targets.push(await connect(`T${i}`));
    for (const t of targets) await request(spammer, t);

    const err = spammer.received("friend:error").find((e) => (e as { error?: string }).error === "muted") as
      | { reason?: string }
      | undefined;
    assert.equal(err?.reason, "spam");
    const reached = targets.filter((t) => t.received("friend:request:incoming").length > 0).length;
    assert.ok(reached < targets.length, `all ${reached} requests arrived`);
  });
});

describe("friends for calls", () => {
  async function send(from: Member, conversationId: string): Promise<void> {
    await from.handlers["chat:send"]({ accessToken: from.accessToken, conversationId, text: "hi", nonce: `n-${Math.random()}` });
  }

  const rang = async (from: Member, to: Member): Promise<boolean> => {
    resetRings();
    to.clear();
    await from.handlers["call:ring"]({ accessToken: from.accessToken, conversationId: directConversationId(from.serverUserId, to.serverUserId) });
    return to.received("call:incoming").length > 0;
  };

  it("somebody you've written to can ring until you have a friend, then only friends can", async () => {
    const me = await connect("Mia");
    const talked = await connect("Tal");
    const pal = await connect("Pal");
    const withTalked = (await openDirectConversation(me.serverUserId, talked.serverUserId)).conversation_id;
    await openDirectConversation(me.serverUserId, pal.serverUserId);
    await send(me, withTalked);

    assert.equal(await rang(talked, me), true, "no friends yet, so writing to them still counts");
    assert.equal(await rang(pal, me), false);

    await request(pal, me);
    await accept(me, pal);
    assert.equal(await rang(pal, me), true);
    assert.equal(await rang(talked, me), false, "with a friend, writing to somebody no longer counts");

    await remove(me, pal);
    assert.equal(await rang(talked, me), true, "and it's back once the last friend goes");
  });
});

describe("a replaced identity", () => {
  it("keeps its friends", async () => {
    const a = await connect("Ada");
    const b = await connect("Ben");
    await request(a, b);
    await accept(b, a);
    await replaceUserIdentity(a.serverUserId, `${a.grytUserId}-new`);
    assert.ok(await areFriends(`${a.grytUserId}-new`, b.grytUserId));
    assert.equal(await areFriends(a.grytUserId, b.grytUserId), false);
  });
});
