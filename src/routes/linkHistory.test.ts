import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLinkHistoryStore, LINK_HISTORY_LIMITS, linkHistoryRouter } from "./linkHistory";

const ID = "a".repeat(26);
const OTHER = "b".repeat(26);

function setup(limits = LINK_HISTORY_LIMITS) {
  const disk = new Map<string, Buffer>();
  let clock = 1_000;
  const store = createLinkHistoryStore(
    {
      put: async (key, body) => void disk.set(key, body),
      get: async (key) => disk.get(key)!,
      del: async (key) => void disk.delete(key),
    },
    limits,
    () => clock,
  );
  return { store, disk, tick: (ms: number) => (clock += ms) };
}

describe("link history store", () => {
  it("gives a chunk back to the user who left it, and nobody else", async () => {
    const { store } = setup();
    assert.equal(await store.put("alice", ID, 0, Buffer.from("sealed")), null);
    assert.deepEqual(await store.get("alice", ID, 0), Buffer.from("sealed"));
    assert.equal(await store.get("mallory", ID, 0), null);
    assert.equal(await store.put("mallory", ID, 1, Buffer.from("x")), "not_found", "another user can't add to it");
    assert.equal(await store.remove("mallory", ID), false);
  });

  it("refuses chunks over the size, users over their total, and a third transfer", async () => {
    const limits = { ...LINK_HISTORY_LIMITS, chunkBytes: 10, userBytes: 15 };
    const { store } = setup(limits);
    assert.equal(await store.put("alice", ID, 0, Buffer.alloc(11)), "too_large");
    assert.equal(await store.put("alice", ID, 0, Buffer.alloc(10)), null);
    assert.equal(await store.put("alice", ID, 1, Buffer.alloc(6)), "too_large", "10 + 6 is over 15");
    assert.equal(await store.put("alice", ID, 0, Buffer.alloc(10)), null, "replacing a chunk counts once");
    assert.equal(await store.put("alice", OTHER, 0, Buffer.alloc(5)), null);
    assert.equal(await store.put("alice", "c".repeat(26), 0, Buffer.alloc(1)), "too_many");
    assert.equal(await store.put("bob", "c".repeat(26), 0, Buffer.alloc(10)), null, "the limits are per user");
  });

  it("refuses ids and slots it doesn't expect", async () => {
    const { store } = setup();
    assert.equal(await store.put("alice", "short", 0, Buffer.from("x")), "bad_request");
    assert.equal(await store.put("alice", "../../etc/passwd/xxxxxxxxxxxx", 0, Buffer.from("x")), "bad_request");
    assert.equal(await store.put("alice", ID, -1, Buffer.from("x")), "bad_request");
    assert.equal(await store.put("alice", ID, 1.5, Buffer.from("x")), "bad_request");
    assert.equal(await store.put("alice", ID, LINK_HISTORY_LIMITS.slots, Buffer.from("x")), "bad_request");
    assert.equal(await store.put("alice", ID, 0, Buffer.alloc(0)), "too_large");
  });

  it("deletes a transfer's files when it's removed or runs out of time", async () => {
    const { store, disk, tick } = setup();
    await store.put("alice", ID, 0, Buffer.from("a"));
    await store.put("alice", ID, 1, Buffer.from("b"));
    assert.equal(await store.remove("alice", ID), true);
    assert.equal(disk.size, 0);

    await store.put("alice", OTHER, 0, Buffer.from("c"));
    tick(LINK_HISTORY_LIMITS.ttlMs);
    assert.equal(await store.get("alice", OTHER, 0), null);
    assert.equal(disk.size, 0, "expired chunks are gone from disk");
  });
});

describe("link history routes", () => {
  it("authenticates before anything reads a body", () => {
    type Layer = { name?: string; route?: object };
    const stack: Layer[] = linkHistoryRouter.stack;
    const auth = stack.findIndex((l) => l.name === "requireBearerToken");
    const firstRoute = stack.findIndex((l) => l.route);
    assert.ok(auth >= 0 && auth < firstRoute, "requireBearerToken runs before every route");
  });
});
