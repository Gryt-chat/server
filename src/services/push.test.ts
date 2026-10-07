import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PushDevice } from "../db";
import type { Clients } from "../types";
import { createPusher, isPresent, readPushRelay } from "./push";

const CAP_A = `p_${"a".repeat(43)}`;
const CAP_B = `p_${"b".repeat(43)}`;

function client(serverUserId: string, extra: Partial<Clients[string]> = {}): Clients[string] {
  return { serverUserId, isAFK: false, ...extra } as Clients[string];
}

function harness(devices: Record<string, PushDevice[]>, status = 202) {
  const calls: { url: string; auth: string; body: string }[] = [];
  const forgotten: string[] = [];
  let now = 1_000_000;
  const pusher = createPusher({
    relay: "https://push.test",
    listDevices: (id) => devices[id] ?? [],
    forget: (cap) => forgotten.push(cap),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization, body: String(init.body) });
      return new Response(null, { status });
    }) as unknown as typeof fetch,
    now: () => now,
  });
  return { pusher, calls, forgotten, tick: (ms: number) => (now += ms) };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("push relay URL", () => {
  it("defaults to the public relay and can be turned off", () => {
    assert.equal(readPushRelay({}), "https://push.gryt.chat");
    assert.equal(readPushRelay({ GRYT_PUSH_RELAY_URL: "off" }), null);
    assert.equal(readPushRelay({ GRYT_PUSH_RELAY_URL: "" }), null);
    assert.equal(readPushRelay({ GRYT_PUSH_RELAY_URL: "https://push.example.org/" }), "https://push.example.org");
  });

  it("refuses plain http except to this machine", () => {
    assert.equal(readPushRelay({ GRYT_PUSH_RELAY_URL: "http://push.example.org" }), null);
    assert.equal(readPushRelay({ GRYT_PUSH_RELAY_URL: "http://localhost:8080" }), "http://localhost:8080");
  });
});

describe("who is at a screen", () => {
  it("counts a socket that is neither idle nor a backgrounded phone", () => {
    assert.equal(isPresent({ a: client("u1") }, "u1"), true);
    assert.equal(isPresent({ a: client("u1", { isAFK: true }) }, "u1"), false);
    assert.equal(isPresent({ a: client("u1", { appInBackground: true }) }, "u1"), false);
    assert.equal(isPresent({ a: client("u1", { appInBackground: true }), b: client("u1") }, "u1"), true);
    assert.equal(isPresent({ a: client("u2") }, "u1"), false);
  });
});

describe("pushing", () => {
  it("sends the capability in the header and only the kind in the body", async () => {
    const h = harness({ u1: [{ installId: "phone-1234", capability: CAP_A }] });
    h.pusher.notify({}, ["u1"], "dm", "conv");
    await flush();
    assert.deepEqual(h.calls, [{ url: "https://push.test/v1/push", auth: `Bearer ${CAP_A}`, body: JSON.stringify({ kind: "dm" }) }]);
  });

  it("skips somebody who is at a screen, and wakes them once they put the phone away", async () => {
    const h = harness({ u1: [{ installId: "phone-1234", capability: CAP_A }] });
    h.pusher.notify({ s: client("u1") }, ["u1"], "mention", "conv");
    await flush();
    assert.equal(h.calls.length, 0);
    h.pusher.notify({ s: client("u1", { appInBackground: true }) }, ["u1"], "mention", "conv");
    await flush();
    assert.equal(h.calls.length, 1);
  });

  it("buzzes once per phone per conversation in fifteen seconds", async () => {
    const h = harness({ u1: [{ installId: "phone-1234", capability: CAP_A }, { installId: "tablet-12", capability: CAP_B }] });
    h.pusher.notify({}, ["u1"], "dm", "conv");
    h.pusher.notify({}, ["u1", "u1"], "dm", "conv");
    h.pusher.notify({}, ["u1"], "dm", "other");
    h.tick(15_000);
    h.pusher.notify({}, ["u1"], "dm", "conv");
    await flush();
    assert.equal(h.calls.length, 6);
  });

  it("forgets a capability the relay calls gone or unknown", async () => {
    for (const status of [404, 410]) {
      const h = harness({ u1: [{ installId: "phone-1234", capability: CAP_A }] }, status);
      h.pusher.notify({}, ["u1"], "dm", "conv");
      await flush();
      await flush();
      assert.deepEqual(h.forgotten, [CAP_A]);
    }
  });

  it("keeps it when the relay is only busy", async () => {
    const h = harness({ u1: [{ installId: "phone-1234", capability: CAP_A }] }, 502);
    h.pusher.notify({}, ["u1"], "dm", "conv");
    await flush();
    await flush();
    assert.deepEqual(h.forgotten, []);
  });
});
