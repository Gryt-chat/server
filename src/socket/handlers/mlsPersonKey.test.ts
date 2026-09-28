import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { IdentityScope } from "@gryt/crypto/dist/scope";

import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { getUserByServerId, setUserDmKeyBinding, upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { broadcastMemberList, buildMemberList } from "../utils/clients";
import { refreshClientPermissions } from "../utils/standing";
import { registerMemberHandlers } from "./members";
import { registerMlsPersonKeyHandlers } from "./mlsPersonKey";
import type { HandlerContext } from "./types";

/** Real bindings signed by @gryt/crypto, so a pass means a client's own check would pass too. */

/* eslint-disable @typescript-eslint/no-require-imports */
const gryt = {
  ...(require("@gryt/crypto/mls-person-key") as typeof import("@gryt/crypto/dist/mls-person-key")),
  ...(require("@gryt/crypto/dm-key-binding") as typeof import("@gryt/crypto/dist/dm-key-binding")),
  ...(require("@gryt/crypto/dm-keys") as typeof import("@gryt/crypto/dist/dm-keys")),
};
/* eslint-enable @typescript-eslint/no-require-imports */

const HOST = "person.test:5001";
const SCOPE = "srv:person-test" as IdentityScope;
const OTHER_SCOPE = "srv:somewhere-else" as IdentityScope;

interface Reply {
  ok: boolean;
  error?: string;
  changed?: boolean;
}

interface Identity {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

interface Member {
  serverUserId: string;
  seed: Uint8Array;
  identity: Identity;
  received: (event: string) => unknown[];
  publish: (binding: unknown, token?: string) => Promise<Reply>;
  fetchMembers: () => Promise<void>;
}

let dir: string;
const clientsInfo: Clients = {};
const sockets = new Map<string, { emit: (event: string, payload?: unknown) => boolean }>();
const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets } };

async function newIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { kty, crv, x, y } };
}

async function dmBinding(m: Member, scope = SCOPE): Promise<string> {
  return gryt.signDmKeyBinding({
    dmPublicKey: gryt.deriveDmKeyPair(m.seed, scope).publicKey,
    scope,
    identityPrivateKey: m.identity.privateKey,
    identityPublicJwk: m.identity.publicJwk,
  });
}

async function personBinding(m: Member, opts: { scope?: IdentityScope; signer?: Identity } = {}): Promise<string> {
  const scope = opts.scope ?? SCOPE;
  const signer = opts.signer ?? m.identity;
  return gryt.signPersonKeyBinding({
    personPublicKey: gryt.derivePersonKeyPair(m.seed, scope).publicKey,
    scope,
    identityPrivateKey: signer.privateKey,
    identityPublicJwk: signer.publicJwk,
  });
}

let seq = 0;
async function connect(nickname: string): Promise<Member> {
  seq += 1;
  const clientId = `person-socket-${seq}`;
  const grytUserId = `account-person-${seq}`;
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
    serverId: "person-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.8.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;
  const handlers = { ...registerMlsPersonKeyHandlers(ctx), ...registerMemberHandlers(ctx) };
  const accessToken = generateAccessToken({ grytUserId, serverUserId: user.server_user_id, nickname, serverHost: HOST, tokenVersion: 0 });

  return {
    serverUserId: user.server_user_id,
    seed: new Uint8Array(randomBytes(32)),
    identity: await newIdentity(),
    received: (event) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    publish: (binding, token = accessToken) =>
      new Promise<Reply>((resolve) => {
        void handlers["mls:person:publish"]({ accessToken: token, binding }, resolve);
      }),
    fetchMembers: async () => {
      await handlers["members:fetch"]();
    },
  };
}

/** A member who has already published a real DM key binding, as a client does on arrival. */
async function withDmKey(nickname: string): Promise<Member> {
  const m = await connect(nickname);
  await setUserDmKeyBinding(m.serverUserId, await dmBinding(m));
  return m;
}

async function stored(m: Member): Promise<string | null> {
  return (await getUserByServerId(m.serverUserId))?.person_key_binding ?? null;
}

type Row = { serverUserId: string; personKeyBinding?: string | null };
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
  dir = mkdtempSync(join(tmpdir(), "gryt-person-key-"));
  process.env.DATA_DIR = dir;
  process.env.JWT_SECRET = "test-secret";
  await initSqlite();
  await createServerConfigIfNotExists();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mls:person:publish", () => {
  it("stores a binding signed by the key behind the DM key binding", async () => {
    const alice = await withDmKey("Alice");
    const binding = await personBinding(alice);

    assert.deepEqual(await alice.publish(binding), { ok: true, changed: true });
    assert.equal(await stored(alice), binding, "handed back byte for byte, since peers verify the signature");
  });

  it("reaches both copies of the member list", async () => {
    const alice = await withDmKey("Alice two");
    const bob = await withDmKey("Bob");
    // Settle the list first, so the only thing left to move the dedupe hash is the binding.
    broadcastMemberList(io as never, clientsInfo, "person-test");
    await waitFor(() => bob.received("members:list").find((l) => rowOf(l, alice)));
    const before = bob.received("members:list").length;

    const binding = await personBinding(alice);
    assert.equal((await alice.publish(binding)).ok, true);

    // The broadcast, which only goes out if the field is in the dedupe hash.
    const broadcast = await waitFor(() =>
      bob.received("members:list").slice(before).find((l) => rowOf(l, alice)?.personKeyBinding === binding),
    );
    assert.ok(broadcast);

    // members:fetch, which a client asks for on connect.
    await bob.fetchMembers();
    const fetched = bob.received("members:list").at(-1);
    assert.equal(rowOf(fetched, alice)?.personKeyBinding, binding);
    assert.equal(rowOf(fetched, bob)?.personKeyBinding, null, "nothing published reads as null, not a key");
  });

  it("answers changed: false for the same binding again", async () => {
    const m = await withDmKey("Repeat");
    const binding = await personBinding(m);
    await m.publish(binding);
    assert.deepEqual(await m.publish(binding), { ok: true, changed: false });
  });

  it("refuses one when there is no DM key binding to check it against", async () => {
    const m = await connect("No DM key");
    const reply = await m.publish(await personBinding(m));
    assert.equal(reply.error, "no_dm_key");
    assert.equal(await stored(m), null);
  });

  it("refuses one when the stored DM key binding doesn't verify", async () => {
    const m = await connect("Junk DM key");
    // dm:key:publish stores anything shaped like a JWT, so this can be in the column.
    await setUserDmKeyBinding(m.serverUserId, "eyJhbGciOiJFUzI1NiJ9.eyJzY29wZSI6InNydjpwZXJzb24tdGVzdCJ9.c2ln");
    assert.equal((await m.publish(await personBinding(m))).error, "no_dm_key");
  });

  it("refuses one signed by a different identity key", async () => {
    const m = await withDmKey("Other signer");
    const reply = await m.publish(await personBinding(m, { signer: await newIdentity() }));
    assert.equal(reply.error, "wrong_identity");
    assert.equal(await stored(m), null);
  });

  it("refuses one signed for a different scope", async () => {
    const m = await withDmKey("Other scope");
    const reply = await m.publish(await personBinding(m, { scope: OTHER_SCOPE }));
    assert.equal(reply.error, "wrong_identity");
    assert.equal(await stored(m), null);
  });

  it("refuses a DM key binding passed off as a person key binding", async () => {
    const m = await withDmKey("Wrong issuer");
    assert.equal((await m.publish(await dmBinding(m))).error, "invalid_binding");
  });

  it("refuses a tampered signature", async () => {
    const m = await withDmKey("Tampered");
    const [h, p, s] = (await personBinding(m)).split(".");
    const flipped = s.startsWith("A") ? `B${s.slice(1)}` : `A${s.slice(1)}`;
    assert.equal((await m.publish(`${h}.${p}.${flipped}`)).error, "invalid_binding");
  });

  it("refuses what isn't a binding at all", async () => {
    // A fresh member each, or the rate limit refuses the later ones and hides a missing guard.
    for (const bad of ["", "not a jwt", "a.b", `${"a".repeat(5000)}.b.c`, 42, {}, ["a.b.c"]]) {
      const m = await withDmKey(`Junk ${seq + 1}`);
      const reply = await m.publish(bad);
      assert.ok(reply.error === "invalid_binding" || reply.error === "invalid_payload",
        `${JSON.stringify(bad).slice(0, 24)} got ${reply.error}`);
      assert.equal(await stored(m), null);
    }
  });

  it("withdraws it with null", async () => {
    const m = await withDmKey("Withdraw");
    await m.publish(await personBinding(m));
    assert.deepEqual(await m.publish(null), { ok: true, changed: true });
    assert.equal(await stored(m), null);
  });

  it("refuses without a valid access token", async () => {
    const m = await withDmKey("No token");
    assert.equal((await m.publish(await personBinding(m), "not-a-token")).error, "unauthenticated");
    assert.equal(await stored(m), null);
  });

  it("stores it against the token's member, whatever the payload names", async () => {
    const alice = await withDmKey("Alice three");
    const bob = await withDmKey("Bob two");
    // Alice's binding sent with Bob's token checks against Bob's DM key, and fails.
    const reply = await bob.publish(await personBinding(alice));
    assert.equal(reply.error, "wrong_identity");
    assert.equal(await stored(alice), null);
    assert.equal(await stored(bob), null);
  });

  it("sits beside the DM key binding in buildMemberList", async () => {
    const m = await withDmKey("Builder");
    const binding = await personBinding(m);
    await m.publish(binding);
    const row = (await buildMemberList(clientsInfo)).find((r) => r.serverUserId === m.serverUserId);
    assert.equal(row?.personKeyBinding, binding);
    assert.ok(row?.dmKeyBinding);
  });
});
