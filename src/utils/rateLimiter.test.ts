import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { checkRateLimit, resetRateLimits, type RateLimitRule } from "./rateLimiter";

// Score settings from the socket handlers, with the window opened wide so only the score decides.
const RULES: Record<string, RateLimitRule> = {
  "whole points": { limit: 1000, windowMs: 60_000, scorePerAction: 1, maxScore: 10, scoreDecayMs: 2000 },
  "half points": { limit: 1000, windowMs: 60_000, scorePerAction: 0.5, maxScore: 15, scoreDecayMs: 3000 },
  "fifth points": { limit: 1000, windowMs: 60_000, scorePerAction: 0.2, maxScore: 6, scoreDecayMs: 1500 },
  "tenths of points": { limit: 1000, windowMs: 60_000, scorePerAction: 0.3, maxScore: 10, scoreDecayMs: 1500 },
  "more than a point": { limit: 1000, windowMs: 60_000, scorePerAction: 2, maxScore: 5, scoreDecayMs: 1000 },
};

/** Fresh limiter, hammered until refused and then `extra` more times; returns the last refusal. */
function refuse(event: string, rule: RateLimitRule, extra: number) {
  resetRateLimits();
  mock.timers.setTime(1_000_000);
  for (let i = 0; i < 1000; i++) {
    const r = checkRateLimit(event, "u1", "203.0.113.7", rule);
    if (!r.allowed) {
      for (let j = 0; j < extra; j++) {
        const again = checkRateLimit(event, "u1", "203.0.113.7", rule);
        assert.equal(again.allowed, false);
        Object.assign(r, again);
      }
      assert.ok(r.retryAfterMs !== undefined && r.retryAfterMs > 0);
      return r.retryAfterMs;
    }
  }
  throw new Error("never refused");
}

function retryAfter(event: string, rule: RateLimitRule, extra: number, waitMs: number) {
  refuse(event, rule, extra);
  mock.timers.tick(waitMs);
  return checkRateLimit(event, "u1", "203.0.113.7", rule).allowed;
}

describe("score-based retryAfterMs", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
  afterEach(() => mock.timers.reset());

  for (const [name, rule] of Object.entries(RULES)) {
    for (const extra of [0, 1, 7, 13]) {
      it(`is exactly when a retry succeeds: ${name}, ${extra} refusals after the first`, () => {
        const event = `t:score:${name}:${extra}`;
        const wait = refuse(event, rule, extra);

        assert.equal(retryAfter(event, rule, extra, wait - 1), false, `refused at ${wait - 1}ms`);
        assert.equal(retryAfter(event, rule, extra, wait), true, `allowed at ${wait}ms`);
      });
    }
  }

  it("is shorter than the time for the score to reach zero", () => {
    const wait = refuse("t:score:short", RULES["whole points"], 0);
    assert.equal(wait, 4000);
  });

  it("reports the time to zero when one action alone is over the limit", () => {
    const rule = { limit: 1000, windowMs: 60_000, scorePerAction: 2.5, maxScore: 2, scoreDecayMs: 1000 };
    assert.equal(refuse("t:score:never", rule, 0), 3000);
  });
});
