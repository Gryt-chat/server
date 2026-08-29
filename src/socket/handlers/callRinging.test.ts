import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { PERMISSIONS, type Permission } from "../../constants/permissions";
import { initSqlite } from "../../db/sqlite/connection";
import { upsertServerChannel } from "../../db/sqlite/channels";
import {
  createGroupConversation,
  directConversationId,
  openDirectConversation,
} from "../../db/sqlite/conversations";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { upsertUser } from "../../db/sqlite/users";
import { generateAccessToken } from "../../utils/jwt";
import { resetRateLimits } from "../../utils/rateLimiter";
import type { Clients } from "../../types";
import { getRing, resetRings, RING_TTL_MS } from "../utils/callRings";
import { resetChannelIdCache } from "../utils/conversationAccess";
import { endRingsFor, registerCallHandlers } from "./calls";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Ringing, and every way it stops.
 *
 * A call is not state — it is an SFU room with people in it — so there is
 * nothing here about calls being in progress. What is tested is the one piece
 * that does need state: reaching somebody who is not looking at the
 * conversation, and then reliably stopping.
 *
 * Everybody has two sockets, because that is where this gets interesting.
 * A ring is addressed to a person rather than to a socket, and the failure
 * this file exists to catch is a phone left ringing in a pocket after the call
 * was answered on a laptop.
 */

const HOST = "calls.test:5001";

let dir: string;

interface Emitted {
  event: string;
  payload: unknown;
}

interface Device {
  clientId: string;
  emitted: Emitted[];
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
}

interface Person {
  serverUserId: string;
  accessToken: string;
  /** Two of them: this person is signed in on a laptop and a phone. */
  devices: Device[];
  laptop: Device;
  phone: Device;
  /** Every event either device saw under this name. */
  received: (event: string) => unknown[];
  clear: () => void;
}

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

async function connectPerson(nickname: string, permissions?: Permission[]): Promise<Person> {
  seq += 1;
  const grytUserId = `account-call-${seq}`;
  const user = await upsertUser(grytUserId, nickname);

  if (permissions) {
    const roleId = `call-role-${seq}`;
    await createRoleDefinition(roleId, { name: `Call ${seq}`, rank: 50, permissions });
    await setServerRole(user.server_user_id, roleId);
  } else {
    await setServerRole(user.server_user_id, "member");
  }

  const accessToken = generateAccessToken({
    grytUserId,
    serverUserId: user.server_user_id,
    nickname,
    serverHost: HOST,
    tokenVersion: 0,
  });

  const devices: Device[] = ["laptop", "phone"].map((kind) => {
    const clientId = `${kind}-${seq}`;
    const emitted: Emitted[] = [];

    const socket = {
      id: clientId,
      handshake: { headers: { host: HOST }, address: "127.0.0.1" },
      emit(event: string, payload?: unknown) {
        emitted.push({ event, payload });
        return true;
      },
      join() {},
      leave() {},
      to() {
        return { emit() {} };
      },
    };

    sockets.set(clientId, {
      emit(event: string, payload?: unknown) {
        emitted.push({ event, payload });
        return true;
      },
    });

    clientsInfo[clientId] = {
      serverUserId: user.server_user_id,
      grytUserId,
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
      socket,
      clientId,
      serverId: "calls-test",
      clientsInfo,
      sfuClient: null,
      getClientIp: () => `10.2.0.${seq}`,
      clientAddressIsOwn: () => true,
    } as unknown as HandlerContext;

    return {
      clientId,
      emitted,
      handlers: registerCallHandlers(ctx),
      received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    };
  });

  return {
    serverUserId: user.server_user_id,
    accessToken,
    devices,
    laptop: devices[0],
    phone: devices[1],
    received: (event: string) => devices.flatMap((d) => d.received(event)),
    clear: () => devices.forEach((d) => (d.emitted.length = 0)),
  };
}

let alice: Person;
let bob: Person;
let mallory: Person;
let pairId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-calls-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  await upsertServerChannel({ channelId: "general", name: "general", type: "voice" });
  resetChannelIdCache();

  alice = await connectPerson("Alice");
  bob = await connectPerson("Bob");
  mallory = await connectPerson("Mallory");

  await openDirectConversation(alice.serverUserId, bob.serverUserId);
  pairId = directConversationId(alice.serverUserId, bob.serverUserId);
});

beforeEach(() => {
  resetRings();
  // The limiter is global and keyed on the caller, so a file that rings as the
  // same person eighteen times trips it partway through and every case after
  // that fails for the wrong reason.
  resetRateLimits();
  [alice, bob, mallory].forEach((p) => p.clear());
});

after(() => {
  resetRings();
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const ring = (p: Person, conversationId: string) =>
  p.laptop.handlers["call:ring"]({ accessToken: p.accessToken, conversationId });

function errors(p: Person): { error?: string }[] {
  return p.received("call:error") as { error?: string }[];
}

describe("starting a ring", () => {
  it("reaches every device the other person has", async () => {
    await ring(alice, pairId);

    assert.equal(bob.laptop.received("call:incoming").length, 1);
    assert.equal(bob.phone.received("call:incoming").length, 1);

    const incoming = bob.laptop.received("call:incoming")[0] as {
      conversation_id: string;
      from: { server_user_id: string; nickname: string };
      expires_at: number;
    };
    assert.equal(incoming.conversation_id, pairId);
    assert.equal(incoming.from.server_user_id, alice.serverUserId);
    assert.equal(incoming.from.nickname, "Alice");
    assert.ok(incoming.expires_at > Date.now());
  });

  it("tells the caller's own other devices that it is ringing", async () => {
    // Started on the laptop; the phone should show it too, rather than showing
    // nothing while the laptop rings.
    await ring(alice, pairId);
    assert.equal(alice.phone.received("call:ringing").length, 1);
  });

  it("does not ring somebody who is not in the conversation", async () => {
    await ring(alice, pairId);
    assert.equal(mallory.received("call:incoming").length, 0);
  });

  it("refuses a conversation that is not the caller's", async () => {
    await ring(mallory, pairId);
    assert.equal(errors(mallory).some((e) => e.error === "not_found"), true);
    assert.equal(bob.received("call:incoming").length, 0);
  });

  it("refuses a channel, which nobody needs telling about", async () => {
    await ring(alice, "general");
    assert.equal(errors(alice).some((e) => e.error === "not_a_conversation"), true);
  });

  it("refuses a second ring in the same conversation", async () => {
    await ring(alice, pairId);
    bob.clear();

    await ring(bob, pairId);
    assert.equal(errors(bob).some((e) => e.error === "already_ringing"), true);
  });

  it("needs join_voice as well as send_direct_messages", async () => {
    const quiet = await connectPerson(
      "Quiet",
      PERMISSIONS.filter((p) => p !== "join_voice"),
    );
    await openDirectConversation(quiet.serverUserId, bob.serverUserId);
    const quietPair = directConversationId(quiet.serverUserId, bob.serverUserId);

    await ring(quiet, quietPair);

    // `requirePermission` answers on `server:error`, the same refusal the door
    // gives, rather than inventing a second shape for the same no.
    const refusals = quiet.received("server:error") as { error?: string; permission?: string }[];
    assert.equal(refusals.some((r) => r.error === "forbidden" && r.permission === "join_voice"), true);
    assert.equal(bob.received("call:incoming").length, 0);
  });
});

describe("stopping a ring", () => {
  it("withdraws from the answerer's other devices when they join", async () => {
    await ring(alice, pairId);
    bob.clear();
    alice.clear();

    // Answering is joining the room. The phone has to stop.
    endRingsFor(io, clientsInfo, { conversationId: pairId, answeredBy: bob.serverUserId });

    const onPhone = bob.phone.received("call:withdrawn") as { reason: string }[];
    assert.equal(onPhone.length, 1);
    assert.equal(onPhone[0].reason, "answered");
    assert.equal(getRing(pairId), null);
  });

  it("tells the caller when it is declined", async () => {
    await ring(alice, pairId);
    alice.clear();

    await bob.laptop.handlers["call:decline"]({ accessToken: bob.accessToken, conversationId: pairId });

    const told = alice.received("call:withdrawn") as { reason: string; ended_by: string }[];
    assert.equal(told.length, 2, "both of the caller's devices");
    assert.equal(told[0].reason, "declined");
    assert.equal(told[0].ended_by, bob.serverUserId);
    assert.equal(getRing(pairId), null);
  });

  it("stops the declining person's own other device too", async () => {
    await ring(alice, pairId);
    bob.clear();

    await bob.laptop.handlers["call:decline"]({ accessToken: bob.accessToken, conversationId: pairId });
    assert.equal(bob.phone.received("call:withdrawn").length, 1);
  });

  it("lets the caller give up", async () => {
    await ring(alice, pairId);
    bob.clear();

    await alice.laptop.handlers["call:cancel"]({ accessToken: alice.accessToken, conversationId: pairId });

    const told = bob.received("call:withdrawn") as { reason: string }[];
    assert.equal(told.length, 2);
    assert.equal(told[0].reason, "cancelled");
    assert.equal(getRing(pairId), null);
  });

  it("does not let the person being rung cancel it", async () => {
    // Cancelling is the caller saying "never mind". Bob saying that is a
    // decline, which tells Alice something different.
    await ring(alice, pairId);
    await bob.laptop.handlers["call:cancel"]({ accessToken: bob.accessToken, conversationId: pairId });
    assert.notEqual(getRing(pairId), null);
  });

  it("does not let somebody outside the conversation decline it", async () => {
    await ring(alice, pairId);
    await mallory.laptop.handlers["call:decline"]({ accessToken: mallory.accessToken, conversationId: pairId });
    assert.notEqual(getRing(pairId), null);
  });

  it("ends the ring when the caller's last socket goes", async () => {
    await ring(alice, pairId);
    bob.clear();

    endRingsFor(io, clientsInfo, { callerGone: alice.serverUserId });

    const told = bob.received("call:withdrawn") as { reason: string }[];
    assert.equal(told.length, 2);
    assert.equal(told[0].reason, "cancelled");
    assert.equal(getRing(pairId), null);
  });

  it("does not end a ring because somebody being rung went away", async () => {
    await ring(alice, pairId);
    endRingsFor(io, clientsInfo, { callerGone: bob.serverUserId });
    assert.notEqual(getRing(pairId), null);
  });

  it("says nothing when declining a ring that already stopped", async () => {
    // The ordinary race: the ring times out a moment before the tap lands.
    bob.clear();
    await bob.laptop.handlers["call:decline"]({ accessToken: bob.accessToken, conversationId: pairId });
    assert.equal(bob.received("call:error").length, 0);
    assert.equal(bob.received("call:withdrawn").length, 0);
  });
});

describe("a ring that nobody answers", () => {
  it("gives up on its own and says so", async () => {
    // Fake timers, because the real answer is thirty seconds and a test that
    // waits for it is a test nobody runs.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await ring(alice, pairId);
      bob.clear();
      alice.clear();

      assert.notEqual(getRing(pairId), null, "still ringing a moment in");
      mock.timers.tick(RING_TTL_MS + 1);

      const atBob = bob.received("call:withdrawn") as { reason: string }[];
      const atAlice = alice.received("call:withdrawn") as { reason: string }[];

      assert.equal(atBob.length, 2, "both of Bob's devices stop");
      assert.equal(atBob[0].reason, "timeout");
      // The caller is told too, or their screen sits on "ringing…" forever.
      assert.equal(atAlice.length, 2);
      assert.equal(atAlice[0].reason, "timeout");
      assert.equal(getRing(pairId), null);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("a group rings everybody in it", () => {
  it("reaches both other members and not the caller", async () => {
    const group = await createGroupConversation(alice.serverUserId, [
      alice.serverUserId,
      bob.serverUserId,
      mallory.serverUserId,
    ]);

    await ring(alice, group.conversation_id);

    assert.equal(bob.received("call:incoming").length, 2, "both of Bob's devices");
    assert.equal(mallory.received("call:incoming").length, 2, "both of Mallory's");
    assert.equal(alice.received("call:incoming").length, 0, "not the caller");
    assert.equal(alice.received("call:ringing").length, 2);
  });

  it("one decline ends it for the whole group", async () => {
    const group = await createGroupConversation(alice.serverUserId, [
      alice.serverUserId,
      bob.serverUserId,
      mallory.serverUserId,
    ]);

    await ring(alice, group.conversation_id);
    mallory.clear();

    await bob.laptop.handlers["call:decline"]({
      accessToken: bob.accessToken,
      conversationId: group.conversation_id,
    });

    // Mallory stops ringing too. The alternative is a caller who has been told
    // no while somebody else's phone carries on.
    assert.equal(mallory.received("call:withdrawn").length, 2);
    assert.equal(getRing(group.conversation_id), null);
  });
});
