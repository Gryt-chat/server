import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DENIAL_RESPONSES } from "./conversationAccess";

/**
 * A swallowed rules read reported as `unknown_conversation`, the same 404 a
 * guessed id gets. The two 404s still match each other, deliberately.
 */

describe("undetermined access", () => {
  it("is not reported as a missing conversation", () => {
    const undetermined = DENIAL_RESPONSES.undetermined;

    assert.notEqual(
      undetermined.error,
      DENIAL_RESPONSES.unknown_conversation.error,
      "a failed check must not answer as a missing conversation",
    );
    assert.notEqual(undetermined.error, DENIAL_RESPONSES.not_a_member.error);
  });

  it("is a retryable status rather than a refusal", () => {
    assert.equal(DENIAL_RESPONSES.undetermined.status, 503);
    assert.equal(DENIAL_RESPONSES.undetermined.error, "unavailable");
  });

  /* `undetermined` describes this server's own state, so unlike the two 404s it
     says nothing about whether the conversation exists. */
  it("says nothing about the conversation", () => {
    const message = DENIAL_RESPONSES.undetermined.message.toLowerCase();
    for (const leak of ["channel", "conversation", "member", "permission", "role"]) {
      assert.ok(
        !message.includes(leak),
        `the message mentions "${leak}", which tells the caller something about the conversation`,
      );
    }
  });

  it("still refuses: every denial stays a denial", () => {
    for (const [reason, response] of Object.entries(DENIAL_RESPONSES)) {
      assert.ok(
        response.status >= 400,
        `${reason} answered ${response.status}, which is not a refusal`,
      );
    }
  });
});
