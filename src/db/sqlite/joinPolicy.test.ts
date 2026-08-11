import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeJoinPolicy } from "./servers";

describe("join policy", () => {
  it("reads the two values it knows", () => {
    assert.equal(normalizeJoinPolicy("invite"), "invite");
    assert.equal(normalizeJoinPolicy("open"), "open");
  });

  it("is case insensitive", () => {
    assert.equal(normalizeJoinPolicy("OPEN"), "open");
  });

  it("fails shut on anything else", () => {
    // The property that matters. A column written by a newer server, a
    // hand-edited row or a typo must leave a server harder to get into, never
    // easier.
    for (const v of [
      undefined,
      null,
      "",
      "  ",
      "approval",
      "openish",
      0,
      1,
      true,
      {},
      [],
    ]) {
      assert.equal(normalizeJoinPolicy(v), "invite", `for ${JSON.stringify(v)}`);
    }
  });
});
