import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { getUserByServerId, setUserAccountKey, upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { buildMemberList } from "../utils/clients";
import { registerDmKeyHandlers } from "./dmKeys";
import type { EventHandlerMap, HandlerContext } from "./types";

/** Both assertions are about what the server does not do: vouch for the binding,
    or let a member park unbounded data in a broadcast column. */

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

  /* A fresh member per case, not for tidiness: five publishes a minute means
     later cases are dropped by the limiter and pass with the guards deleted. */
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
      // The only input the length check is the one refusing: anything malformed
      // is caught by the shape first.
      `${"a".repeat(4100)}.b.c`,
    ]) {
      assert.equal(await publishAs(bad), null,
        `"${bad.slice(0, 24)}" was stored`);
    }
  });

  it("refuses a type that is not a string", async () => {
    /* `["a.b.c"]` is the one that matters: it stringifies to exactly that
       string, sails through the shape check, and reaches the column as an array. */
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
    /* The payload has to actually name a victim: without one the fallback to the
       socket still runs, and the case passes with the check inverted. */
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

describe("one identity per account (GRYT-1868)", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const gryt = {
    ...(require("@gryt/crypto/dm-key-binding") as typeof import("@gryt/crypto/dist/dm-key-binding")),
    ...(require("@gryt/crypto/dm-keys") as typeof import("@gryt/crypto/dist/dm-keys")),
    ...(require("@gryt/crypto/key-handover") as typeof import("@gryt/crypto/dist/key-handover")),
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
  const scope = "srv:one-identity" as Parameters<typeof gryt.deriveDmKeyPair>[1];

  async function device() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    return () =>
      gryt.signDmKeyBinding({
        dmPublicKey: gryt.deriveDmKeyPair(seed, scope).publicKey,
        scope,
        identityPrivateKey: pair.privateKey,
        identityPublicJwk: { kty, crv, x, y },
      });
  }

  const publish = (m: Member, payload: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => void m.handlers["dm:key:publish"](payload, resolve));

  it("keeps the account's key when a device with its own key publishes, and says why", async () => {
    const carol = await connect("Carol");
    const [desktop, phone] = [await device(), await device()];
    const first = await desktop();

    assert.deepEqual(await publish(carol, { binding: first }), { ok: true, changed: true });
    assert.equal((await publish(carol, { binding: await phone() })).error, "other_identity");
    assert.equal(await bindingOf(carol.serverUserId), first);

    const again = await desktop();
    assert.equal((await publish(carol, { binding: again })).ok, true, "the same identity signing again is fine");
    assert.equal(await bindingOf(carol.serverUserId), again);
  });

  it("won't let a session swap the account's key without the current key's say-so (GRYT-1886)", async () => {
    const dave = await connect("Dave");
    const [lost, fresh] = [await device(), await device()];
    const original = await lost();
    await publish(dave, { binding: original });

    const replacement = await fresh();
    assert.equal((await publish(dave, { binding: replacement, replace: true })).error, "handover_required",
      "a password alone must not be able to replace the key everyone pinned");
    assert.equal(await bindingOf(dave.serverUserId), original);
  });

  it("takes the account's key when the device signs for the key its certificate names", async () => {
    const erin = await connect("Erin");
    const [old, mine] = [await device(), await device()];
    await publish(erin, { binding: await old() });
    const account = await generateKeyPair("ES256");
    const accountJwk = await exportJWK(account.publicKey);
    await setUserAccountKey(erin.serverUserId, await calculateJwkThumbprint(accountJwk));
    const sign = (binding: string, key = account.privateKey, jwk = accountJwk) =>
      new SignJWT({ binding }).setProtectedHeader({ alg: "ES256", jwk }).sign(key);

    const next = await mine();
    assert.equal((await publish(erin, { binding: next, replace: true })).error, "handover_required", "no proof, no move");
    assert.equal((await publish(erin, { binding: next, replace: true, account: await sign(await mine()) })).error, "handover_required", "a proof for another binding");
    const other = await generateKeyPair("ES256");
    assert.equal((await publish(erin, { binding: next, replace: true, account: await sign(next, other.privateKey, await exportJWK(other.publicKey)) })).error,
      "handover_required", "a key the certificate doesn't name");

    assert.equal((await publish(erin, { binding: next, replace: true, account: await sign(next) })).ok, true);
    assert.equal(await bindingOf(erin.serverUserId), next);
  });
});

describe("device approval prompts", () => {
  it("pass the ticket to your other devices only, and a no reaches the asker", async () => {
    const mac = await connect("Mac owner");
    const pcId = "socket-pc";
    clientsInfo[pcId] = { ...clientsInfo[mac.clientId] } as Clients[string];
    const stranger = await connect("Someone else");
    const got: Record<string, { event: string; body: unknown }[]> = {};
    for (const id of [mac.clientId, pcId, stranger.clientId]) {
      got[id] = [];
      io.sockets.sockets.set(id, { emit: (event: string, body: unknown) => got[id].push({ event, body }) });
    }

    await mac.handlers["device:approve:ask"]({ ticket: "not a jwt" });
    assert.equal(got[pcId].length, 0, "only something shaped like a ticket is passed on");
    const ticket = shapedLikeABinding();
    await mac.handlers["device:approve:ask"]({ ticket });
    assert.deepEqual(got[pcId], [{ event: "device:approve:asked", body: { askId: mac.clientId, ticket } }]);
    assert.equal(got[mac.clientId].length, 0, "not to itself");
    assert.equal(got[stranger.clientId].length, 0, "not to another account");

    await stranger.handlers["device:approve:deny"]({ askId: mac.clientId });
    assert.equal(got[mac.clientId].length, 0, "another account can't say no for you");

    const pc = { handlers: registerDmKeyHandlers({ io, socket: { id: pcId, emit() {}, join() {}, leave() {} }, clientId: pcId, serverId: "key-test", clientsInfo, sfuClient: null, getClientIp: () => "10.0.9.9", clientAddressIsOwn: () => true } as unknown as HandlerContext) };
    await pc.handlers["device:approve:deny"]({ askId: mac.clientId });
    assert.deepEqual(got[mac.clientId], [{ event: "device:approve:denied", body: {} }]);
  });
});
