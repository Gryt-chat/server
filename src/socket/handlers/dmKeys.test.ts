import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { buildMemberList } from "../utils/clients";
import { registerDmKeyHandlers } from "./dmKeys";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Publishing a DM key binding (GRYT-720).
 *
 * The server stores an opaque string and hands it back in the member list, and
 * the two things worth asserting are both about what it does *not* do. It must
 * not read or vouch for the binding, because a peer has to establish that for
 * itself and a server that appeared to check it would invite somebody to skip
 * doing so. And it must not let a member park unbounded data in a column that
 * goes to every other member on every broadcast.
 */

let dir: string;

interface Member {
  clientId: string;
  serverUserId: string;
  handlers: EventHandlerMap;
}

const clientsInfo: Clients = {};
const io = {
  to() {
    return { emit() {} };
  },
  emit() {},
  sockets: { sockets: new Map() },
};

let seq = 0;

async function connect(nickname: string): Promise<Member> {
  seq += 1;
  const clientId = `socket-${seq}`;
  const user = await upsertUser(`account-key-${seq}`, nickname);
  await setServerRole(user.server_user_id, "member");

  clientsInfo[clientId] = {
    serverUserId: user.server_user_id,
    grytUserId: `account-key-${seq}`,
    nickname,
    color: "#666666",
    isMuted: false,
    isDeafened: false,
    streamID: "",
    hasJoinedChannel: false,
    voiceChannelId: "",
    isAFK: false,
    cameraEnabled: false,
    cameraStreamID: "",
    screenShareEnabled: false,
    screenShareVideoStreamID: "",
    screenShareAudioStreamID: "",
    isServerMuted: false,
    isServerDeafened: false,
  } as Clients[string];

  const ctx = {
    io,
    socket: { id: clientId, emit() {}, join() {}, leave() {} },
    clientId,
    serverId: "key-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.0.1.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return { clientId, serverUserId: user.server_user_id, handlers: registerDmKeyHandlers(ctx) };
}

/** Three base64url segments. Not a real signature — the server never checks one. */
function shapedLikeABinding(payload = "eyJzY29wZSI6InNydjphYmMifQ"): string {
  return `eyJhbGciOiJFUzI1NiJ9.${payload}.c2lnbmF0dXJl`;
}

async function bindingOf(serverUserId: string): Promise<string | null> {
  return (await getUserByServerId(serverUserId))?.dm_key_binding ?? null;
}

let alice: Member;
let bob: Member;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-dm-keys-"));
  process.env.DATA_DIR = dir;
  process.env.JWT_SECRET = "test-secret";
  await initSqlite();
  await createServerConfigIfNotExists();
  alice = await connect("Alice");
  bob = await connect("Bob");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("publishing a DM key binding", () => {
  it("stores what a member sends, without reading it", async () => {
    const binding = shapedLikeABinding();
    await alice.handlers["dm:key:publish"]({ binding });

    assert.equal(await bindingOf(alice.serverUserId), binding,
      "the binding has to come back byte for byte; the client verifies a signature over it");
  });

  it("hands it to the other members", async () => {
    const members = await buildMemberList(clientsInfo);
    const entry = members.find((m) => m.serverUserId === alice.serverUserId);

    assert.equal(entry?.dmKeyBinding, shapedLikeABinding(),
      "a binding nobody else can see is a key nobody can encrypt to");
  });

  it("leaves a member who has published nothing at null", async () => {
    const members = await buildMemberList(clientsInfo);
    const entry = members.find((m) => m.serverUserId === bob.serverUserId);

    // Not undefined, not a placeholder: a client tells "no encrypted messages
    // with this person" from null, and anything else is a key it might try.
    assert.equal(entry?.dmKeyBinding, null,
      "somebody who has not published a key must not appear to have one");
  });

  it("lets a member replace their own", async () => {
    const replacement = shapedLikeABinding("eyJzY29wZSI6InNydjpkZWYifQ");
    await alice.handlers["dm:key:publish"]({ binding: replacement });

    assert.equal(await bindingOf(alice.serverUserId), replacement,
      "a member whose identity changed has to be able to say so, and peers refuse the change themselves");
  });

  it("lets a member withdraw it", async () => {
    await alice.handlers["dm:key:publish"]({ binding: null });

    assert.equal(await bindingOf(alice.serverUserId), null,
      "a client with no identity to sign with must be able to stop people encrypting to a key nobody holds");
  });

  /*
   * A fresh member per case, and this is not tidiness.
   *
   * `dm:key:publish` is rate limited to five in a minute, which is generous for
   * something a client sends once. Looping bad inputs through one member spends
   * that budget in three cases and then every later one is dropped by the
   * limiter rather than by the guard under test — so the assertions all pass,
   * and they pass with the guards deleted. Both the length cap and the type
   * check were verified that way before this was noticed.
   */
  async function publishAs(binding: unknown): Promise<string | null> {
    const member = await connect(`Guard ${seq + 1}`);
    await member.handlers["dm:key:publish"]({ binding: binding as string });
    return bindingOf(member.serverUserId);
  }

  it("refuses what could not be a binding", async () => {
    for (const bad of [
      "",
      "not a jwt",
      "only.two",
      "four.parts.are.wrong",
      "has spaces.in.it",
      "a".repeat(5000),
      // Correctly shaped and over the cap, which is the only input the length
      // check is the one refusing. Anything malformed is caught by the shape
      // first, so a case that used one passes with the cap deleted.
      `${"a".repeat(4100)}.b.c`,
    ]) {
      assert.equal(await publishAs(bad), null,
        `"${bad.slice(0, 24)}" was stored`);
    }
  });

  it("refuses a type that is not a string", async () => {
    /*
     * `["a.b.c"]` is the one that matters. A number or a plain object is
     * refused by the shape check anyway, because the regex stringifies its
     * argument and neither produces three base64url segments — so a case using
     * only those passes with the type check deleted. An array of one string
     * stringifies to exactly that string, sails through the shape, and reaches
     * the column as an array.
     */
    for (const bad of [42, {}, true, ["a.b.c"], ["eyJhIjoxfQ.eyJiIjoyfQ.c2ln"]]) {
      assert.equal(await publishAs(bad), null,
        `${JSON.stringify(bad)} was stored`);
    }
  });

  it("stops a client that publishes in a loop", async () => {
    const member = await connect("Looper");
    const good = shapedLikeABinding();

    // Five is the budget. Each of these is a different valid binding, so
    // nothing is skipped for being unchanged, and the sixth has to be dropped.
    for (let i = 0; i < 5; i++) {
      await member.handlers["dm:key:publish"]({ binding: shapedLikeABinding(`eyJpIjoke${i}fQ`) });
    }
    const before = await bindingOf(member.serverUserId);
    await member.handlers["dm:key:publish"]({ binding: good });

    assert.equal(await bindingOf(member.serverUserId), before,
      "the sixth publish in a minute has to be dropped; this column is broadcast to every member");
  });

  it("does not let one member set another's", async () => {
    /*
     * The payload names a victim, several ways. Alice publishing her own key
     * and Bob's staying put does not test this — with the member read off the
     * payload the fallback to the socket still runs when no name is there, so
     * that version passes with the check inverted. The payload has to actually
     * carry one.
     */
    for (const field of ["serverUserId", "who", "userId", "target", "member"]) {
      const before = await bindingOf(bob.serverUserId);
      await alice.handlers["dm:key:publish"]({
        binding: shapedLikeABinding("eyJtaW5lIjp0cnVlfQ"),
        [field]: bob.serverUserId,
      } as { binding: string });

      assert.equal(await bindingOf(bob.serverUserId), before,
        `"${field}" in the payload moved somebody else's key`);
    }
  });
});
