import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { MESSAGE_MAX_LENGTH, MESSAGE_TOO_LONG } from "./messageLimits";

/*
 * The cap is enforced in three places and the handlers are socket closures that
 * a unit test cannot reach without standing up a server. So what is tested here
 * is the constant, and then — by reading the source — that all three doors
 * actually go through it.
 *
 * That second part is the one that matters. The bug this fixes was not a wrong
 * number, it was two doors with no check at all while a third had its own copy
 * of 4000 written inline. A test that only asserted the constant would have
 * passed on the day the bug shipped.
 */

const src = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

test("the cap matches what the webhook route has always refused", () => {
  // Not a new number. Changing it is a product decision, so it should be a
  // deliberate edit here rather than a side effect of touching a handler.
  assert.equal(MESSAGE_MAX_LENGTH, 4000);
});

test("the refusal names the limit", () => {
  assert.equal(MESSAGE_TOO_LONG.error, "message_too_long");
  assert.match(MESSAGE_TOO_LONG.message, /4,000/);
});

test("sending checks the length", () => {
  const chat = src("socket/handlers/chat.ts");
  assert.match(chat, /text\.length > MESSAGE_MAX_LENGTH/);
});

test("editing checks it too, so the cap cannot be edited around", () => {
  // Send four characters, edit them into four million. This is the bypass, and
  // it is why the assertion below counts two call sites rather than one.
  const chat = src("socket/handlers/chat.ts");
  const checks = chat.match(/text\.length > MESSAGE_MAX_LENGTH/g) ?? [];
  assert.equal(checks.length, 2, "expected chat:send and chat:edit to both check");
});

test("the webhook route uses the shared constant rather than its own copy", () => {
  const webhooks = src("routes/webhooks.ts");
  assert.match(webhooks, /text\.length > MESSAGE_MAX_LENGTH/);
  assert.doesNotMatch(
    webhooks,
    /text\.length > 4000/,
    "the inline 4000 should be gone — two copies is how they drift",
  );
});
