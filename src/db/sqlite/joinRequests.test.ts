import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeNote, normalizeStatus } from "./joinRequests";

describe("join request status", () => {
  it("reads the values it knows", () => {
    assert.equal(normalizeStatus("pending"), "pending");
    assert.equal(normalizeStatus("approved"), "approved");
    assert.equal(normalizeStatus("denied"), "denied");
  });

  it("is case insensitive", () => {
    assert.equal(normalizeStatus("APPROVED"), "approved");
  });

  it("fails shut on anything else", () => {
    // The property that matters, and the same one normalizeJoinPolicy has. A
    // row written by a newer server, a hand-edited status or a typo must leave
    // somebody outside the door, never inside it. "approved" is the only value
    // that admits anyone, so it has to be spelled exactly.
    for (const v of [
      undefined,
      null,
      "",
      "  ",
      "approve",
      "approved ",
      "accepted",
      "ok",
      "yes",
      0,
      1,
      true,
      {},
      [],
    ]) {
      assert.notEqual(normalizeStatus(v), "approved", `for ${JSON.stringify(v)}`);
      assert.equal(normalizeStatus(v), "pending", `for ${JSON.stringify(v)}`);
    }
  });
});

describe("join request note", () => {
  it("keeps a normal note", () => {
    assert.equal(normalizeNote("  let me in please  "), "let me in please");
  });

  it("treats an empty or blank note as none", () => {
    assert.equal(normalizeNote(""), null);
    assert.equal(normalizeNote("   "), null);
  });

  it("ignores anything that is not a string", () => {
    // The note arrives on a socket payload from somebody who is not a member
    // yet, so it is the least trusted string in the join path.
    for (const v of [undefined, null, 0, 1, true, {}, [], { toString: () => "x" }]) {
      assert.equal(normalizeNote(v), null, `for ${JSON.stringify(v)}`);
    }
  });

  it("caps the length", () => {
    const long = "a".repeat(1000);
    assert.equal(normalizeNote(long)?.length, 300);
  });
});
