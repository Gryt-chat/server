import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SFU_RECONNECT_GRACE_MS,
  withinSfuReconnectGrace,
} from "./sfuReconnectGrace";

describe("withinSfuReconnectGrace", () => {
  it("keeps a newly re-announced voice user alive while the SFU catches up", () => {
    const now = 50_000;
    assert.equal(withinSfuReconnectGrace(now - 1_500, now), true);
  });

  it("expires at the grace boundary", () => {
    const now = 50_000;
    assert.equal(
      withinSfuReconnectGrace(now - SFU_RECONNECT_GRACE_MS, now),
      false,
    );
  });

  it("does not grace a user with no tracked SFU connection", () => {
    assert.equal(withinSfuReconnectGrace(undefined, 50_000), false);
  });
});
