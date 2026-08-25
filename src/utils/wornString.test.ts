import assert from "node:assert/strict";
import { test } from "node:test";

import { readWornUpdate } from "./wornString";

test("a missing field leaves the stored look alone", () => {
  assert.deepEqual(readWornUpdate(undefined), { kind: "unchanged" });
});

test("null and empty both clear the look", () => {
  assert.deepEqual(readWornUpdate(null), { kind: "clear" });
  assert.deepEqual(readWornUpdate(""), { kind: "clear" });
  assert.deepEqual(readWornUpdate("   "), { kind: "clear" });
});

test("a well-formed string is stored lower case and trimmed", () => {
  assert.deepEqual(readWornUpdate("aiac----adAB"), { kind: "set", worn: "aiac----adab" });
  assert.deepEqual(readWornUpdate("  aaaaaaaaaa  "), { kind: "set", worn: "aaaaaaaaaa" });
});

test("all-empty fields are a look, not an absence", () => {
  // Somebody who took everything off. Distinct from clearing, which goes back
  // to whatever the seed draws.
  assert.deepEqual(readWornUpdate("----------------"), {
    kind: "set",
    worn: "----------------",
  });
});

test("anything that is not whole two-character fields is refused", () => {
  for (const bad of ["a", "abc", "ab-", "ab_cd", "ab cd", "ab1c", "ÅÅ"]) {
    assert.deepEqual(readWornUpdate(bad), { kind: "invalid" }, `expected ${bad} to be refused`);
  }
});

test("non-strings are refused rather than coerced", () => {
  for (const bad of [42, true, {}, [], { worn: "aaaa" }]) {
    assert.deepEqual(readWornUpdate(bad), { kind: "invalid" });
  }
});

test("a very long string is refused", () => {
  assert.deepEqual(readWornUpdate("ab".repeat(33)), { kind: "invalid" });
});

test("a string longer than this build writes is accepted", () => {
  // The point of the cap being generous. A client that has grown a sixth slot
  // writes 18 characters, and this server has to store it rather than refuse
  // the release — the clients are what decide which fields they can draw.
  assert.deepEqual(readWornUpdate("aiac----adabacab"), {
    kind: "set",
    worn: "aiac----adabacab",
  });
  assert.deepEqual(readWornUpdate("aiac----adabacabxy"), {
    kind: "set",
    worn: "aiac----adabacabxy",
  });
});
