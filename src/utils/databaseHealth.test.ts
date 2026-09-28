import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WriteProbeResult } from "../db/sqlite/connection";
import { createDatabaseHealth, WRITE_PROBE_INTERVAL_MS } from "./databaseHealth";

function setup(results: WriteProbeResult[]) {
  let t = 1_000_000;
  let calls = 0;
  const health = createDatabaseHealth(
    () => {
      calls++;
      const next = results.shift();
      if (!next) throw new Error("probe called more often than the test expected");
      return next;
    },
    () => t,
  );
  return {
    health,
    calls: () => calls,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("database health", () => {
  it("is unhealthy while init is still running", () => {
    const { health, calls } = setup([]);
    assert.deepEqual(health.check(), { healthy: false, detail: "starting" });
    assert.equal(calls(), 0);
  });

  it("is unhealthy for good when init failed, without probing", () => {
    const { health, calls, advance } = setup([]);
    health.failed();
    assert.deepEqual(health.check(), { healthy: false, detail: "init failed" });
    advance(WRITE_PROBE_INTERVAL_MS * 3);
    assert.deepEqual(health.check(), { healthy: false, detail: "init failed" });
    assert.equal(calls(), 0);
  });

  it("probes on the first check and then at most once per interval", () => {
    const { health, calls, advance } = setup(["ok", "ok"]);
    health.opened();
    for (let i = 0; i < 50; i++) assert.deepEqual(health.check(), { healthy: true });
    assert.equal(calls(), 1);
    advance(WRITE_PROBE_INTERVAL_MS - 1);
    health.check();
    assert.equal(calls(), 1);
    advance(1);
    health.check();
    assert.equal(calls(), 2);
  });

  it("reports a database that can't be written, and its recovery", () => {
    const { health, advance } = setup(["failed", "ok"]);
    health.opened();
    assert.deepEqual(health.check(), { healthy: false, detail: "not writable" });
    assert.deepEqual(health.check(), { healthy: false, detail: "not writable" });
    advance(WRITE_PROBE_INTERVAL_MS);
    assert.deepEqual(health.check(), { healthy: true });
  });

  it("keeps the last answer when the probe finds the lock busy", () => {
    const { health, advance } = setup(["busy", "failed", "busy"]);
    health.opened();
    assert.deepEqual(health.check(), { healthy: true });
    advance(WRITE_PROBE_INTERVAL_MS);
    assert.deepEqual(health.check(), { healthy: false, detail: "not writable" });
    advance(WRITE_PROBE_INTERVAL_MS);
    assert.deepEqual(health.check(), { healthy: false, detail: "not writable" });
  });

  it("treats a probe that throws as not writable", () => {
    const { health } = setup([]);
    health.opened();
    assert.deepEqual(health.check(), { healthy: false, detail: "not writable" });
  });
});
