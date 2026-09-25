import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getSqliteDb, initSqlite } from "./connection";
import { openDirectConversation, purgeOrphanedConversations } from "./conversations";
import { mergeGuestIntoAccount } from "./mergeGuest";
import {
  addMlsKeyPackages,
  appendMlsCommit,
  appendMlsMessage,
  claimMlsKeyPackage,
  countMlsKeyPackages,
  createMlsGroup,
  deleteMlsWelcomes,
  getMlsGroup,
  listMlsDevices,
  listMlsGroupsForMember,
  listMlsLog,
  listMlsWelcomes,
  MLS_MAX_DEVICES,
  MLS_MAX_KEY_PACKAGES,
  mlsKeyPackageOwner,
  oldestMlsSeq,
  removeMlsDevice,
  sweepMls,
  touchMlsDevice,
} from "./mls";
import { upsertUser } from "./users";

/** The storage half of the MLS delivery service. The handler tests cover who may call
    what; these cover what the tables promise whoever calls them. */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-mls-db-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (...b: number[]) => new Uint8Array(b);
const DAY = 24 * 60 * 60 * 1000;

let uniq = 0;
async function member(): Promise<string> {
  uniq += 1;
  return (await upsertUser(`mls-db-${uniq}`, `Member ${uniq}`)).server_user_id;
}

async function conversation(): Promise<string> {
  return (await openDirectConversation(await member(), await member())).conversation_id;
}

describe("devices", () => {
  it("caps each member at five and lets a known one back in", async () => {
    const me = await member();
    for (let i = 0; i < MLS_MAX_DEVICES; i++) assert.equal(touchMlsDevice(me, `d${i}`), "ok");

    assert.equal(touchMlsDevice(me, "one-too-many"), "too_many_devices");
    assert.equal(touchMlsDevice(me, "d0"), "ok", "a device already known is never refused by the cap");
    assert.equal(listMlsDevices([me]).length, MLS_MAX_DEVICES);
  });

  it("frees the slot, its packages and its Welcomes when removed", async () => {
    const me = await member();
    touchMlsDevice(me, "phone");
    addMlsKeyPackages(me, "phone", [{ ref: "ref-removed", data: bytes(1), lastResort: false }]);

    assert.equal(removeMlsDevice(me, "phone"), true);
    assert.deepEqual(listMlsDevices([me]), []);
    assert.equal(mlsKeyPackageOwner("ref-removed"), null);
  });
});

describe("KeyPackages", () => {
  it("keeps twenty per device and hands them out once each, oldest first", async () => {
    const me = await member();
    const packages = Array.from({ length: MLS_MAX_KEY_PACKAGES + 5 }, (_, i) => ({
      ref: `kp-${me}-${i}`,
      data: bytes(i),
      lastResort: false,
    }));
    const t0 = new Date("2026-09-25T10:00:00Z");
    const { stored, unclaimed } = addMlsKeyPackages(me, "laptop", packages, t0);
    assert.equal(stored, MLS_MAX_KEY_PACKAGES);
    assert.equal(unclaimed, MLS_MAX_KEY_PACKAGES);

    const first = claimMlsKeyPackage(me, "laptop");
    const second = claimMlsKeyPackage(me, "laptop");
    assert.equal(first?.ref, `kp-${me}-0`);
    assert.equal(second?.ref, `kp-${me}-1`);
    assert.notEqual(first?.ref, second?.ref, "a KeyPackage used twice would let two groups share one init key");
    assert.equal(countMlsKeyPackages(me, "laptop").unclaimed, MLS_MAX_KEY_PACKAGES - 2);

    const row = getSqliteDb()
      .prepare(`SELECT data FROM mls_key_packages WHERE key_package_ref = ?`)
      .get(first!.ref) as { data: Uint8Array | null };
    assert.equal(row.data, null, "a handed-out package's bytes are gone");
    assert.deepEqual(mlsKeyPackageOwner(first!.ref), { serverUserId: me, deviceId: "laptop" });
  });

  it("falls back to the last-resort package, again and again", async () => {
    const me = await member();
    addMlsKeyPackages(me, "tablet", [
      { ref: `once-${me}`, data: bytes(1), lastResort: false },
      { ref: `last-${me}`, data: bytes(9), lastResort: true },
    ]);

    assert.equal(claimMlsKeyPackage(me, "tablet")?.ref, `once-${me}`);
    const a = claimMlsKeyPackage(me, "tablet");
    const b = claimMlsKeyPackage(me, "tablet");
    assert.equal(a?.lastResort, true);
    assert.equal(b?.ref, `last-${me}`);
    assert.deepEqual(b?.data, bytes(9));
  });

  it("retires the old last-resort package when a new one comes, and still routes to it", async () => {
    const me = await member();
    addMlsKeyPackages(me, "desk", [{ ref: `old-${me}`, data: bytes(1), lastResort: true }]);
    addMlsKeyPackages(me, "desk", [{ ref: `new-${me}`, data: bytes(2), lastResort: true }]);

    assert.equal(claimMlsKeyPackage(me, "desk")?.ref, `new-${me}`);
    assert.deepEqual(mlsKeyPackageOwner(`old-${me}`), { serverUserId: me, deviceId: "desk" });
  });

  it("gives nothing for a device with nothing", async () => {
    assert.equal(claimMlsKeyPackage(await member(), "nothing"), null);
  });
});

describe("groups and commit ordering", () => {
  it("keeps the first group registered for a conversation", async () => {
    const conv = await conversation();
    const first = createMlsGroup("aa01", conv, "u1");
    const second = createMlsGroup("aa02", conv, "u2");

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.group?.groupId, "aa01", "the loser has to learn which group to wait for");
  });

  it("refuses a group id already used by another conversation", async () => {
    createMlsGroup("aa03", await conversation(), "u1");
    const reuse = createMlsGroup("aa03", await conversation(), "u1");
    assert.deepEqual(reuse, { created: false, group: null });
  });

  it("accepts one commit per epoch and tells the rest where the group is", async () => {
    const conv = await conversation();
    createMlsGroup("bb01", conv, "u1");
    const base = { groupId: "bb01", senderServerUserId: "u1", senderDeviceId: "d1" };

    const results = [1, 2, 3].map((n) => appendMlsCommit({ ...base, epoch: 0, data: bytes(n) }));
    assert.equal(results.filter((r) => r.accepted).length, 1);
    for (const r of results.slice(1)) {
      assert.deepEqual(r, { accepted: false, reason: "stale_epoch", epoch: 1, headSeq: 1 });
    }

    const next = appendMlsCommit({ ...base, epoch: 1, data: bytes(4) });
    assert.equal(next.accepted && next.epoch, 2);
    assert.equal(getMlsGroup("bb01")?.epoch, 2);
    assert.deepEqual(listMlsLog("bb01", 0, 10).map((e) => e.data[0]), [1, 4], "a refused commit is never written");
  });

  it("orders messages by seq without ordering them by epoch", async () => {
    const conv = await conversation();
    createMlsGroup("cc01", conv, "u1");
    const base = { groupId: "cc01", senderServerUserId: "u1", senderDeviceId: "d1" };

    appendMlsCommit({ ...base, epoch: 0, data: bytes(1) });
    appendMlsCommit({ ...base, epoch: 1, data: bytes(2) });
    const late = appendMlsMessage("application", { ...base, epoch: 1, data: bytes(3) });
    const ahead = appendMlsMessage("application", { ...base, epoch: 3, data: bytes(4) });

    assert.equal(late.accepted, true, "a message sent just before a commit still has to land");
    assert.deepEqual(ahead, { accepted: false, reason: "future_epoch", epoch: 2 });
    assert.deepEqual(listMlsLog("cc01", 0, 10).map((e) => [e.seq, e.kind]), [
      [1, "commit"],
      [2, "commit"],
      [3, "application"],
    ]);
  });

  it("writes a resend once and answers it with the first seq", async () => {
    const conv = await conversation();
    createMlsGroup("cc02", conv, "u1");
    const base = { groupId: "cc02", senderServerUserId: "u1", senderDeviceId: "d1" };

    const commit = appendMlsCommit({ ...base, epoch: 0, data: bytes(1) });
    const commitAgain = appendMlsCommit({ ...base, epoch: 0, data: bytes(1) });
    assert.deepEqual(commitAgain.accepted && [commitAgain.seq, commitAgain.epoch, commitAgain.duplicate], [1, 1, true],
      "a commit retried after a lost reply is the one that won, not a stale one");
    assert.ok(commit.accepted && !commit.duplicate);

    const sent = appendMlsMessage("application", { ...base, epoch: 1, data: bytes(2) });
    const again = appendMlsMessage("application", { ...base, epoch: 1, data: bytes(2) });
    assert.deepEqual(again.accepted && [again.seq, again.duplicate], [2, true]);
    assert.ok(sent.accepted && !sent.duplicate);
    assert.equal(listMlsLog("cc02", 0, 10).length, 2);
  });

  it("pages the log from a cursor", async () => {
    const conv = await conversation();
    createMlsGroup("dd01", conv, "u1");
    for (let i = 0; i < 7; i++) {
      appendMlsMessage("application", { groupId: "dd01", epoch: 0, senderServerUserId: "u1", senderDeviceId: "d", data: bytes(i) });
    }
    assert.deepEqual(listMlsLog("dd01", 0, 3).map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(listMlsLog("dd01", 3, 3).map((e) => e.seq), [4, 5, 6]);
    assert.deepEqual(listMlsLog("dd01", 6, 3).map((e) => e.seq), [7]);
    assert.deepEqual(listMlsLog("dd01", 7, 3), []);
  });

  it("lists the groups a member is in, and only those", async () => {
    const a = await member();
    const b = await member();
    const outsider = await member();
    const conv = (await openDirectConversation(a, b)).conversation_id;
    createMlsGroup("ee01", conv, a);

    assert.deepEqual(listMlsGroupsForMember(a).map((g) => g.groupId), ["ee01"]);
    assert.deepEqual(listMlsGroupsForMember(outsider), []);
  });
});

describe("Welcomes", () => {
  it("are written with the commit and only deleted by the device they are for", async () => {
    const conv = await conversation();
    createMlsGroup("ff01", conv, "u1");
    const res = appendMlsCommit(
      { groupId: "ff01", epoch: 0, senderServerUserId: "u1", senderDeviceId: "d1", data: bytes(1) },
      [{ serverUserId: "u2", deviceId: "phone", data: bytes(7) }],
    );
    assert.ok(res.accepted);
    const [welcome] = listMlsWelcomes("u2", "phone");
    assert.equal(welcome.conversationId, conv);
    assert.deepEqual(welcome.data, bytes(7));

    assert.equal(deleteMlsWelcomes("u3", "phone", [welcome.welcomeId]), 0);
    assert.equal(deleteMlsWelcomes("u2", "laptop", [welcome.welcomeId]), 0);
    assert.equal(deleteMlsWelcomes("u2", "phone", [welcome.welcomeId]), 1);
    assert.deepEqual(listMlsWelcomes("u2", "phone"), []);
  });

  it("are not written for a refused commit", async () => {
    const conv = await conversation();
    createMlsGroup("ff02", conv, "u1");
    const base = { groupId: "ff02", senderServerUserId: "u1", senderDeviceId: "d1" };
    appendMlsCommit({ ...base, epoch: 0, data: bytes(1) });
    appendMlsCommit({ ...base, epoch: 0, data: bytes(2) }, [{ serverUserId: "u9", deviceId: "x", data: bytes(3) }]);
    assert.deepEqual(listMlsWelcomes("u9", "x"), []);
  });
});

describe("retention", () => {
  it("drops what is older than the cutoff and never reuses a seq", async () => {
    const conv = await conversation();
    createMlsGroup("aa99", conv, "u1");
    const base = { groupId: "aa99", senderServerUserId: "u1", senderDeviceId: "d1" };
    const old = new Date(Date.now() - 40 * DAY);
    appendMlsCommit({ ...base, epoch: 0, data: bytes(1) }, [{ serverUserId: "u2", deviceId: "p", data: bytes(1) }], old);
    appendMlsMessage("application", { ...base, epoch: 1, data: bytes(2) }, old);
    appendMlsMessage("application", { ...base, epoch: 1, data: bytes(3) });

    const me = await member();
    addMlsKeyPackages(me, "d", [
      { ref: `swept-${me}`, data: bytes(1), lastResort: false },
      { ref: `waiting-${me}`, data: bytes(2), lastResort: false },
    ], old);
    claimMlsKeyPackage(me, "d", old);

    const swept = sweepMls(new Date(Date.now() - 30 * DAY));
    assert.ok(swept.log >= 2);
    assert.ok(swept.welcomes >= 1);
    assert.ok(swept.keyPackages >= 1);

    assert.deepEqual(listMlsLog("aa99", 0, 10).map((e) => e.seq), [3]);
    assert.equal(oldestMlsSeq("aa99"), 3, "a device whose cursor is behind this knows it has a gap");
    assert.equal(mlsKeyPackageOwner(`swept-${me}`), null);
    assert.ok(mlsKeyPackageOwner(`waiting-${me}`), "an unclaimed package is not ciphertext, and stays");

    const again = appendMlsMessage("application", { ...base, epoch: 1, data: bytes(4) });
    assert.equal(again.accepted && again.seq, 4);
    assert.equal(getMlsGroup("aa99")?.epoch, 1, "sweeping the log leaves the epoch where it was");
  });

  it("drops a group whose conversation is gone, with its log", async () => {
    const conv = await conversation();
    createMlsGroup("ab01", conv, "u1");
    appendMlsMessage("application", { groupId: "ab01", epoch: 0, senderServerUserId: "u1", senderDeviceId: "d", data: bytes(1) });
    getSqliteDb().prepare(`DELETE FROM conversations WHERE conversation_id = ?`).run(conv);

    const swept = sweepMls(new Date(Date.now() - 30 * DAY));
    assert.ok(swept.groups >= 1);
    assert.equal(getMlsGroup("ab01"), null);
    assert.deepEqual(listMlsLog("ab01", 0, 10), []);
  });
});

describe("lifecycle", () => {
  it("drops the group with its conversation, so the pair's next DM starts clean", async () => {
    const a = await member();
    const b = await member();
    const conv = (await openDirectConversation(a, b)).conversation_id;
    createMlsGroup("ac01", conv, a);
    getSqliteDb().prepare(`UPDATE users SET is_active = 0 WHERE server_user_id IN (?, ?)`).run(a, b);

    assert.ok((await purgeOrphanedConversations()).includes(conv));
    assert.equal(getMlsGroup("ac01"), null);
  });

  it("moves a guest's devices, packages and Welcomes to the account it merges into", async () => {
    const guest = await upsertUser("mls-guest", "Guest");
    const account = await upsertUser("mls-account", "Account");
    touchMlsDevice(guest.server_user_id, "shared");
    touchMlsDevice(guest.server_user_id, "only-guest");
    touchMlsDevice(account.server_user_id, "shared");
    addMlsKeyPackages(guest.server_user_id, "only-guest", [{ ref: "guest-kp", data: bytes(1), lastResort: false }]);

    assert.ok(mergeGuestIntoAccount("mls-guest", "mls-account"));
    assert.deepEqual(listMlsDevices([account.server_user_id]).map((d) => d.deviceId).sort(), ["only-guest", "shared"]);
    assert.deepEqual(mlsKeyPackageOwner("guest-kp"), { serverUserId: account.server_user_id, deviceId: "only-guest" });
  });
});
