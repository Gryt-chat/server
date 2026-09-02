import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Permission } from "../../constants/permissions";
import { isUserBanned } from "../../db/sqlite/servers";
import { initSqlite } from "../../db/sqlite/connection";
import { createRoleDefinition } from "../../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../../db/sqlite/users";
import { listUserReports } from "../../db/sqlite/userReports";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerReportHandlers } from "./reports";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Reporting a person, driven through the handlers.
 *
 * `permissionGates.test.ts` already proves both new events refuse a role
 * without the permission they name. Nothing here repeats that. What is left is
 * the part a gate cannot answer: whether the queue holds what the reporter
 * wrote, whether the reported person is ever told, and whether the two
 * eviction buttons ask for more than `manage_reports` before they fire.
 *
 * The last one is the reason this file exists. `manage_reports` gets you the
 * card; a queue that could ban on it alone would be a way around the member
 * list, which is exactly the hole the message queue had until GRYT-576 put
 * `requireOutranks` on delete-all-and-ban.
 */

const HOST = "userreports.test:5001";

let dir: string;

interface Emitted {
  event: string;
  payload: unknown;
}

interface Actor {
  clientId: string;
  serverUserId: string;
  grytUserId: string;
  accessToken: string;
  emitted: Emitted[];
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
  clear: () => void;
}

/**
 * One shared `io`, so an eviction has sockets it can actually reach.
 *
 * `disconnect` is on here because `evictUser` calls it — a stub with only
 * `emit` throws inside the handler, and the handler's catch turns that into a
 * refusal that looks exactly like a permission check firing.
 */
interface FakeSocket {
  emit: (event: string, payload?: unknown) => boolean;
  disconnect: () => void;
  disconnected: boolean;
}
const sockets = new Map<string, FakeSocket>();
const clientsInfo: Clients = {};
const io = {
  to() {
    return { emit() {} };
  },
  emit() {},
  sockets: { sockets },
};

let seq = 0;

/**
 * A connected member holding exactly the permissions given.
 *
 * `rank` rises with the permission set on purpose: the moderators below need to
 * outrank the people they act on, and a rank tie is refused before any
 * permission is read.
 */
async function connect(nickname: string, permissions: Permission[], rank = 10): Promise<Actor> {
  seq += 1;
  const clientId = `socket-${seq}`;
  const roleId = `role-${seq}`;
  const grytUserId = `account-report-${seq}`;

  await createRoleDefinition(roleId, { name: `Role ${seq}`, rank, permissions });
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, roleId);

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
    disconnect() {},
  };

  const fake: FakeSocket = {
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    disconnect() {
      fake.disconnected = true;
    },
    disconnected: false,
  };
  sockets.set(clientId, fake);

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
    serverId: "user-reports-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.1.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    clientId,
    serverUserId: user.server_user_id,
    grytUserId,
    accessToken: generateAccessToken({
      grytUserId,
      serverUserId: user.server_user_id,
      nickname,
      serverHost: HOST,
      tokenVersion: 0,
    }),
    emitted,
    handlers: registerReportHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
    clear: () => {
      emitted.length = 0;
    },
  };
}

const REPORTER: Permission[] = ["read_messages", "view_members", "report_messages"];
const MOD_NO_TEETH: Permission[] = [...REPORTER, "view_reports", "manage_reports"];
const MOD_KICK: Permission[] = [...MOD_NO_TEETH, "kick_members"];
const MOD_BAN: Permission[] = [...MOD_NO_TEETH, "ban_members"];

interface QueueCard {
  reportedServerUserId: string;
  reportedNickname: string | null;
  reportCount: number;
  reporters: string[];
  reasons: Array<{ reporterServerUserId: string; reporterNickname: string | null; reason: string }>;
}

/** The user half of whatever `reports:list` answers this moderator. */
async function queue(mod: Actor): Promise<QueueCard[]> {
  mod.clear();
  await mod.handlers["reports:list"]({ accessToken: mod.accessToken });
  const payload = mod.received("reports:list").at(-1) as { userReports?: QueueCard[] } | undefined;
  return payload?.userReports ?? [];
}

async function report(who: Actor, whom: Actor, reason: string): Promise<void> {
  who.clear();
  await who.handlers["user:report"]({
    accessToken: who.accessToken,
    serverUserId: whom.serverUserId,
    reason,
  });
}

function refusedForbidden(actor: Actor): boolean {
  return actor.emitted.some(
    (e) => (e.payload as { error?: string } | undefined)?.error === "forbidden",
  );
}

let alice: Actor;
let bob: Actor;
let mallory: Actor;
let owner: Actor;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-user-reports-"));
  process.env.DATA_DIR = dir;
  // requireAuth refuses everything without a config row, which would make every
  // refusal below pass for the wrong reason.
  await initSqlite();
  await createServerConfigIfNotExists();

  alice = await connect("Alice", REPORTER);
  bob = await connect("Bob", REPORTER);
  // Above every moderator here, so "reporting somebody who outranks you" and
  // "a moderator cannot ban above themselves" are both real cases.
  mallory = await connect("Mallory", REPORTER, 90);
  owner = await connect("Owner", MOD_BAN, 100);
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("submitting a report about a person", () => {
  it("puts the reason in the queue, under the reported person", async () => {
    const target = await connect("Target One", REPORTER);
    await report(alice, target, "following me between channels");

    assert.deepEqual(alice.received("report:user_submitted"), [
      { serverUserId: target.serverUserId },
    ]);

    const cards = await queue(owner);
    const card = cards.find((c) => c.reportedServerUserId === target.serverUserId);
    assert.ok(card, "the reported person is not in the queue");
    assert.equal(card.reportCount, 1);
    assert.equal(card.reasons[0].reason, "following me between channels");
    assert.equal(card.reasons[0].reporterServerUserId, alice.serverUserId);
    assert.equal(card.reportedNickname, "Target One");
    /* Snapshotted, not resolved at read time: the person who reported
       harassment is often the one who then leaves. */
    assert.equal(card.reasons[0].reporterNickname, "Alice");
  });

  it("tells the reported person nothing", async () => {
    const target = await connect("Target Two", REPORTER);
    target.clear();
    await report(alice, target, "shouting in voice");

    assert.deepEqual(
      target.emitted,
      [],
      "the reported person received something, which invites retaliation",
    );
  });

  it("counts two reporters as one card", async () => {
    const target = await connect("Target Three", REPORTER);
    await report(alice, target, "first account of it");
    await report(bob, target, "second account of it");

    const cards = await queue(owner);
    const card = cards.find((c) => c.reportedServerUserId === target.serverUserId);
    assert.equal(card?.reportCount, 2);
    assert.equal(card?.reasons.length, 2);
  });

  it("refuses a second open report from the same person", async () => {
    const target = await connect("Target Four", REPORTER);
    await report(alice, target, "the first one");
    await report(alice, target, "the same thing again");

    assert.deepEqual(alice.received("report:user_already_reported"), [
      { serverUserId: target.serverUserId },
    ]);

    const cards = await queue(owner);
    const card = cards.find((c) => c.reportedServerUserId === target.serverUserId);
    assert.equal(card?.reportCount, 1);
    assert.equal(card?.reasons.length, 1, "the duplicate was stored anyway");
  });

  it("refuses reporting yourself", async () => {
    alice.clear();
    await alice.handlers["user:report"]({
      accessToken: alice.accessToken,
      serverUserId: alice.serverUserId,
      reason: "testing",
    });
    assert.deepEqual(alice.received("chat:error"), ["You cannot report yourself"]);
    assert.equal(alice.received("report:user_submitted").length, 0);
  });

  it("refuses a report with nothing written on it", async () => {
    const target = await connect("Target Five", REPORTER);
    for (const reason of ["", "   ", "\n\t "]) {
      alice.clear();
      await alice.handlers["user:report"]({
        accessToken: alice.accessToken,
        serverUserId: target.serverUserId,
        reason,
      });
      assert.deepEqual(alice.received("chat:error"), ["Invalid report payload"]);
    }
    assert.equal((await queue(owner)).filter(
      (c) => c.reportedServerUserId === target.serverUserId,
    ).length, 0);
  });

  it("refuses a reason longer than the cap", async () => {
    const target = await connect("Target Six", REPORTER);
    alice.clear();
    await alice.handlers["user:report"]({
      accessToken: alice.accessToken,
      serverUserId: target.serverUserId,
      reason: "x".repeat(1001),
    });
    assert.equal(alice.received("report:user_submitted").length, 0);
    assert.match(String(alice.received("chat:error")[0]), /under 1000 characters/);
  });

  it("lets somebody report a person who outranks them", async () => {
    // The one report that must never be refused. Mallory is rank 90, Alice 10.
    await report(alice, mallory, "the person in charge is the problem");
    assert.deepEqual(alice.received("report:user_submitted"), [
      { serverUserId: mallory.serverUserId },
    ]);
    assert.equal(alice.received("chat:error").length, 0);

    // Cleared again so the eviction cases below start from an empty queue.
    owner.clear();
    await owner.handlers["reports:resolve_user"]({
      accessToken: owner.accessToken,
      reportedServerUserId: mallory.serverUserId,
      action: "dismiss",
    });
  });
});

describe("resolving a report about a person", () => {
  it("dismissing closes every open report about them at once", async () => {
    const target = await connect("Target Seven", REPORTER);
    await report(alice, target, "one");
    await report(bob, target, "two");

    owner.clear();
    await owner.handlers["reports:resolve_user"]({
      accessToken: owner.accessToken,
      reportedServerUserId: target.serverUserId,
      action: "dismiss",
    });

    assert.deepEqual(owner.received("reports:user_resolved"), [
      { reportedServerUserId: target.serverUserId, action: "dismiss" },
    ]);

    const cards = await queue(owner);
    assert.equal(
      cards.filter((c) => c.reportedServerUserId === target.serverUserId).length,
      0,
      "the card is still in the queue with a smaller count",
    );

    const rows = await listUserReports("dismissed");
    assert.equal(rows.filter((r) => r.reported_server_user_id === target.serverUserId).length, 2);
  });

  it("refuses to ban on manage_reports alone", async () => {
    const target = await connect("Target Eight", REPORTER);
    const mod = await connect("Toothless", MOD_NO_TEETH, 50);
    await report(alice, target, "worth a ban");

    mod.clear();
    await mod.handlers["reports:resolve_user"]({
      accessToken: mod.accessToken,
      reportedServerUserId: target.serverUserId,
      action: "ban",
    });

    assert.ok(refusedForbidden(mod), "the queue banned without ban_members");
    assert.equal(await isUserBanned(target.grytUserId), false);

    // And the report is still there to be handled by somebody who may.
    const cards = await queue(owner);
    assert.ok(cards.some((c) => c.reportedServerUserId === target.serverUserId));
  });

  it("refuses to kick on manage_reports alone", async () => {
    const target = await connect("Target Nine", REPORTER);
    const mod = await connect("Toothless Two", MOD_NO_TEETH, 50);
    await report(alice, target, "worth a kick");

    mod.clear();
    await mod.handlers["reports:resolve_user"]({
      accessToken: mod.accessToken,
      reportedServerUserId: target.serverUserId,
      action: "kick",
    });

    assert.ok(refusedForbidden(mod), "the queue kicked without kick_members");
    const cards = await queue(owner);
    assert.ok(cards.some((c) => c.reportedServerUserId === target.serverUserId));
  });

  it("refuses to ban somebody who outranks the moderator", async () => {
    const mod = await connect("Middle", MOD_BAN, 50);
    await report(alice, mallory, "rank 90 against rank 50");

    mod.clear();
    await mod.handlers["reports:resolve_user"]({
      accessToken: mod.accessToken,
      reportedServerUserId: mallory.serverUserId,
      action: "ban",
    });

    assert.ok(refusedForbidden(mod));
    assert.equal(await isUserBanned(mallory.grytUserId), false);
  });

  it("banning bans, evicts, and marks the reports actioned", async () => {
    const target = await connect("Target Ten", REPORTER);
    await report(alice, target, "banning this one");

    owner.clear();
    await owner.handlers["reports:resolve_user"]({
      accessToken: owner.accessToken,
      reportedServerUserId: target.serverUserId,
      action: "ban",
    });

    assert.deepEqual(owner.received("reports:user_resolved"), [
      { reportedServerUserId: target.serverUserId, action: "ban" },
    ]);
    assert.equal(await isUserBanned(target.grytUserId), true);

    // Eviction is what makes the ban immediate rather than eventual.
    const user = await getUserByServerId(target.serverUserId);
    assert.equal(user?.is_active, false, "the banned user's session was left usable");

    const rows = await listUserReports("actioned");
    assert.ok(rows.some((r) => r.reported_server_user_id === target.serverUserId));
    assert.equal(
      (await queue(owner)).filter((c) => c.reportedServerUserId === target.serverUserId).length,
      0,
    );
  });

  it("kicking evicts without banning", async () => {
    const target = await connect("Target Eleven", REPORTER);
    const mod = await connect("Kicker", MOD_KICK, 50);
    await report(alice, target, "kicking this one");

    mod.clear();
    await mod.handlers["reports:resolve_user"]({
      accessToken: mod.accessToken,
      reportedServerUserId: target.serverUserId,
      action: "kick",
    });

    assert.deepEqual(mod.received("reports:user_resolved"), [
      { reportedServerUserId: target.serverUserId, action: "kick" },
    ]);
    assert.equal(
      await isUserBanned(target.grytUserId),
      false,
      "a kick from the queue wrote a ban row",
    );

    const user = await getUserByServerId(target.serverUserId);
    assert.equal(user?.is_active, false);
  });

  it("refuses an action it does not know", async () => {
    owner.clear();
    await owner.handlers["reports:resolve_user"]({
      accessToken: owner.accessToken,
      reportedServerUserId: alice.serverUserId,
      action: "delete_everything" as "dismiss",
    });
    assert.equal(owner.received("reports:user_resolved").length, 0);
    assert.ok(
      owner.emitted.some(
        (e) => (e.payload as { error?: string } | undefined)?.error === "invalid_payload",
      ),
    );
  });
});
