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

  /** A device whose identity key the test can also sign a handover with. */
  async function signer() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const publicJwk = { kty, crv, x, y };
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const binding = () =>
      gryt.signDmKeyBinding({ dmPublicKey: gryt.deriveDmKeyPair(seed, scope).publicKey, scope, identityPrivateKey: pair.privateKey, identityPublicJwk: publicJwk });
    return { binding, privateKey: pair.privateKey, publicJwk };
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

  it("takes a replacement the current key handed over, and only that one", async () => {
    const erin = await connect("Erin");
    const [oldMac, iphone, thief] = [await signer(), await signer(), await signer()];
    const old = await oldMac.binding();
    await publish(erin, { binding: old });

    const next = await iphone.binding();
    const forged = await gryt.signKeyHandover({ newBinding: next, scope, identityPrivateKey: thief.privateKey, identityPublicJwk: thief.publicJwk });
    assert.equal((await publish(erin, { binding: next, replace: true, handover: forged })).error, "handover_required");

    const forOther = await gryt.signKeyHandover({ newBinding: await thief.binding(), scope, identityPrivateKey: oldMac.privateKey, identityPublicJwk: oldMac.publicJwk });
    assert.equal((await publish(erin, { binding: next, replace: true, handover: forOther })).error, "handover_required",
      "a real note for another key can't be reused");

    const real = await gryt.signKeyHandover({ newBinding: next, scope, identityPrivateKey: oldMac.privateKey, identityPublicJwk: oldMac.publicJwk });
    assert.deepEqual(await publish(erin, { binding: next, replace: true, handover: real }), { ok: true, changed: true });
    assert.equal(await bindingOf(erin.serverUserId), next);
  });

  it("passes a handover request to the account's other devices only", async () => {
    const frank = await connect("Frank");
    const frankPhone = await connect("Frank's phone");
    clientsInfo[frankPhone.clientId].serverUserId = frank.serverUserId;
    const stranger = await connect("Stranger");
    const heard: Record<string, unknown[]> = {};
    for (const m of [frank, frankPhone, stranger]) {
      io.sockets.sockets.set(m.clientId, { emit: (event: string, body: unknown) => (heard[m.clientId] ??= []).push([event, body]) });
    }
    const binding = await (await signer()).binding();
    frank.handlers["dm:key:handover:ask"]({ binding, deviceName: "Mac" });

    assert.deepEqual(heard[frankPhone.clientId], [["dm:key:handover:asked", { binding, deviceName: "Mac", askerId: frank.clientId }]]);
    assert.equal(heard[stranger.clientId], undefined, "nobody else's devices hear it");
    assert.equal(heard[frank.clientId], undefined, "the asker doesn't ask itself");

    stranger.handlers["dm:key:handover:deny"]({ askerId: frank.clientId });
    assert.equal(heard[frank.clientId], undefined, "only the account's own devices can say no");
    frankPhone.handlers["dm:key:handover:deny"]({ askerId: frank.clientId });
    assert.deepEqual(heard[frank.clientId], [["dm:key:handover:denied", {}]]);
  });
});
