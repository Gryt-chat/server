import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER = import.meta.dirname;

function fakeApi({ moderation } = {}) {
  const sent = [];
  const topics = new Map();
  const events = new Map();
  const logs = [];
  return {
    sent,
    logs,
    emit: (name, payload) => events.get(name)?.(payload),
    say: (topic, message) => topics.get(topic)?.(message),
    api: {
      id: "test",
      capabilities: [],
      on: (name, handler) => events.set(name, handler),
      messaging: {
        on: (topic, handler) => topics.set(topic, handler),
        send: (topic, data, target = "everyone") => {
          sent.push({ topic, data, target });
          return true;
        },
      },
      moderation: moderation ?? {},
      log: {
        info: (m) => logs.push(["info", m]),
        warn: (m) => logs.push(["warn", m]),
        error: (m) => logs.push(["error", m]),
      },
    },
  };
}

test("presence: a game goes on the roster, keyed off the connection", async () => {
  const f = fakeApi();
  const { activate } = await import(`${SERVER}/presence/index.mjs`);
  activate(f.api);

  f.say("playing", { data: { v: 1, game: "Factorio" }, userId: "u1", nickname: "mira" });
  assert.deepEqual(f.sent.at(-1), {
    topic: "roster",
    data: [{ who: "mira", game: "Factorio" }],
    target: "everyone",
  });

  // A name in the payload is ignored; the connection is the only source.
  f.say("playing", {
    data: { v: 1, game: "Tetris", who: "admin", nickname: "admin" },
    userId: "u2",
    nickname: null,
  });
  assert.deepEqual(f.sent.at(-1).data, [
    { who: "mira", game: "Factorio" },
    { who: "Somebody", game: "Tetris" },
  ]);
});

test("presence: junk is dropped and sends nothing", async () => {
  const f = fakeApi();
  const { activate } = await import(`${SERVER}/presence/index.mjs`);
  activate(f.api);

  f.say("playing", { data: { game: "Factorio" }, userId: "u1", nickname: "a" }); // no v
  f.say("playing", { data: { v: 2, game: "Factorio" }, userId: "u1", nickname: "a" }); // wrong v
  f.say("playing", { data: { v: 1, game: 42 }, userId: "u1", nickname: "a" }); // not a string
  f.say("playing", { data: null, userId: "u1", nickname: "a" });
  f.say("playing", { data: { v: 1, game: null }, userId: "u1", nickname: "a" }); // off, but was never on
  assert.equal(f.sent.length, 0);

  // A long name is cut before anybody sees it.
  f.say("playing", { data: { v: 1, game: "x".repeat(500) }, userId: "u1", nickname: "a" });
  assert.equal(f.sent.at(-1).data[0].game.length, 80);
});

test("presence: hello answers one member, and only when there is something", async () => {
  const f = fakeApi();
  const { activate } = await import(`${SERVER}/presence/index.mjs`);
  activate(f.api);

  f.say("hello", { data: { v: 1 }, userId: "u9", nickname: "new" });
  assert.equal(f.sent.length, 0, "an empty roster is not worth a message");

  f.say("playing", { data: { v: 1, game: "Factorio" }, userId: "u1", nickname: "mira" });
  f.say("hello", { data: { v: 1 }, userId: "u9", nickname: "new" });
  assert.deepEqual(f.sent.at(-1), {
    topic: "roster",
    data: [{ who: "mira", game: "Factorio" }],
    target: ["u9"],
  });
});

test("presence: leaving takes you off, and only once", async () => {
  const f = fakeApi();
  const { activate } = await import(`${SERVER}/presence/index.mjs`);
  activate(f.api);

  f.say("playing", { data: { v: 1, game: "Factorio" }, userId: "u1", nickname: "mira" });
  f.emit("member:left", { userId: "u1", nickname: "mira", reason: "left" });
  assert.deepEqual(f.sent.at(-1).data, []);

  const before = f.sent.length;
  f.emit("member:left", { userId: "u1", nickname: "mira", reason: "left" });
  f.emit("member:left", { userId: "nobody", nickname: null, reason: "kicked" });
  assert.equal(f.sent.length, before, "somebody not on the roster is not news");
});

function guard({ deleteOk = true, banOk = true, deleteReason = "no" } = {}) {
  const calls = [];
  return {
    calls,
    moderation: {
      deleteMessage: async (channelId, messageId) => {
        calls.push(["delete", channelId, messageId]);
        return deleteOk ? { ok: true } : { ok: false, reason: deleteReason };
      },
      ban: async (userId, options) => {
        calls.push(["ban", userId, options]);
        return banOk ? { ok: true } : { ok: false, reason: "no" };
      },
      kick: async () => ({ ok: true }),
    },
  };
}

/* The sweep is fired without being awaited, so give the microtasks a turn. */
const settle = () => sleep(0);

async function post(f, { userId = "u1", nickname = "mira", channelId, text, messageId }) {
  f.emit("message:created", {
    messageId,
    channelId,
    userId,
    nickname,
    text,
    attachmentCount: 0,
    at: new Date().toISOString(),
  });
  await settle();
}

test("crosspost-guard: three channels is a sweep, two is not", async () => {
  const g = guard();
  const f = fakeApi({ moderation: g.moderation });
  const { activate } = await import(`${SERVER}/crosspost-guard/index.mjs`);
  activate(f.api);

  const text = "free steam keys at example dot com";
  await post(f, { channelId: "c1", text, messageId: "m1" });
  await post(f, { channelId: "c2", text, messageId: "m2" });
  assert.equal(g.calls.length, 0, "two channels is somebody answering twice");

  await post(f, { channelId: "c3", text, messageId: "m3" });
  assert.deepEqual(g.calls, [
    ["delete", "c1", "m1"],
    ["delete", "c2", "m2"],
    ["delete", "c3", "m3"],
  ]);
});

test("crosspost-guard: the same channel twice is not crossposting", async () => {
  const g = guard();
  const f = fakeApi({ moderation: g.moderation });
  const { activate } = await import(`${SERVER}/crosspost-guard/index.mjs`);
  activate(f.api);

  const text = "the same long message again";
  await post(f, { channelId: "c1", text, messageId: "m1" });
  await post(f, { channelId: "c1", text, messageId: "m2" });
  await post(f, { channelId: "c1", text, messageId: "m3" });
  assert.equal(g.calls.length, 0);
});

test("crosspost-guard: short text and two different people are left alone", async () => {
  const g = guard();
  const f = fakeApi({ moderation: g.moderation });
  const { activate } = await import(`${SERVER}/crosspost-guard/index.mjs`);
  activate(f.api);

  for (const channelId of ["c1", "c2", "c3"]) {
    await post(f, { channelId, text: "ok thanks", messageId: `s-${channelId}` });
  }
  assert.equal(g.calls.length, 0, "short messages land everywhere honestly");

  const text = "a perfectly ordinary sentence";
  await post(f, { userId: "a", channelId: "c1", text, messageId: "m1" });
  await post(f, { userId: "b", channelId: "c2", text, messageId: "m2" });
  await post(f, { userId: "c", channelId: "c3", text, messageId: "m3" });
  assert.equal(g.calls.length, 0, "three people agreeing is not one script");
});

test("crosspost-guard: the second sweep bans", async () => {
  const g = guard();
  const f = fakeApi({ moderation: g.moderation });
  const { activate } = await import(`${SERVER}/crosspost-guard/index.mjs`);
  activate(f.api);

  for (const round of [1, 2]) {
    const text = `free steam keys round ${round}`;
    for (const channelId of ["c1", "c2", "c3"]) {
      await post(f, { channelId, text, messageId: `${round}-${channelId}` });
    }
  }

  const ban = g.calls.find(([kind]) => kind === "ban");
  assert.ok(ban, "a second sweep inside the hour is a script");
  assert.equal(ban[1], "u1");
  assert.equal(ban[2].durationMs, 24 * 60 * 60_000);
  assert.equal(g.calls.filter(([kind]) => kind === "delete").length, 6);
});

test("crosspost-guard: a refused delete stops the sweep and never bans", async () => {
  const g = guard({ deleteOk: false, deleteReason: "that member is a moderator here (manage_messages)" });
  const f = fakeApi({ moderation: g.moderation });
  const { activate } = await import(`${SERVER}/crosspost-guard/index.mjs`);
  activate(f.api);

  for (const round of [1, 2]) {
    const text = `moderator posting the same notice ${round}`;
    for (const channelId of ["c1", "c2", "c3"]) {
      await post(f, { channelId, text, messageId: `${round}-${channelId}` });
    }
  }

  assert.equal(g.calls.filter(([kind]) => kind === "delete").length, 2, "one attempt per sweep");
  assert.equal(g.calls.filter(([kind]) => kind === "ban").length, 0);
  assert.ok(f.logs.some(([level, m]) => level === "warn" && m.includes("moderator")));
});
