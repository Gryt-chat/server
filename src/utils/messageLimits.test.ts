import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { MESSAGE_MAX_LENGTH, MESSAGE_TOO_LONG } from "./messageLimits";

/*
 * The constant, and then by reading the source that all three doors go through
 * it: the bug was two doors with no check and a third with 4000 written inline.
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

test("every way to put text in a message checks the cap", () => {
  // Four characters edited into four million is the bypass, so this counts call
  // sites. Failing here means going to look at the new one, not raising it.
  const chat = src("socket/handlers/chat.ts");
  const checks = chat.match(/text\.length > MESSAGE_MAX_LENGTH/g) ?? [];
  assert.equal(
    checks.length,
    3,
    "a text path in chat.ts either stopped checking the cap, or a new one was added without checking it",
  );
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
