import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DENIAL_RESPONSES } from "./conversationAccess";

/**
 * "I could not check" must not answer as "there is no such conversation".
 *
 * A failed rules read used to be swallowed inside `mayViewChannel`, which
 * returned false, which the caller reported as `unknown_conversation` — the
 * same 404 a guessed id gets. A client cannot tell those apart, and voice gives
 * up after five attempts across twenty seconds, so a database that was busy for
 * a moment took somebody out of a call they could have rejoined.
 *
 * These pin the contract that separates them. The two 404s still say the same
 * thing as each other, which is deliberate and unrelated: telling *those* apart
 * would say whether a conversation exists.
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

  /*
   * The reason this is safe to distinguish at all. `undetermined` describes
   * this server's own state, so it says nothing about whether the conversation
   * exists or who is in it — unlike telling the two 404s apart, which would.
   */
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
