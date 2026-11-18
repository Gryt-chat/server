import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizePlanMode, refusesEvent } from "./planMode";

test("an unknown or missing mode is active", () => {
  assert.equal(normalizePlanMode(undefined), "active");
  assert.equal(normalizePlanMode("frozen"), "active");
  assert.equal(normalizePlanMode("paused"), "paused");
});

test("read-only refuses writes and keeps reading, voice and deleting", () => {
  assert.equal(refusesEvent("read_only", "chat:send", false), true);
  assert.equal(refusesEvent("read_only", "chat:send", true), true);
  assert.equal(refusesEvent("read_only", "chat:fetch", false), false);
  assert.equal(refusesEvent("read_only", "voice:state:update", false), false);
  assert.equal(refusesEvent("read_only", "chat:delete", false), false);
});

test("paused refuses everything except for the owner", () => {
  assert.equal(refusesEvent("paused", "chat:fetch", false), true);
  assert.equal(refusesEvent("paused", "chat:send", true), false);
  assert.equal(refusesEvent("active", "chat:send", false), false);
});
