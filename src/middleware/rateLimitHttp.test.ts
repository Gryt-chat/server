import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { resetRateLimits } from "../utils/rateLimiter";
import { httpRateLimit, requestIp, RL_HTTP_API, RL_HTTP_EMOJI_WRITE, RL_HTTP_FILE, RL_HTTP_OUTBOUND, RL_HTTP_UPLOAD } from "./rateLimitHttp";

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
  setHeader(k: string, v: string): void;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
};

function res(): FakeRes {
  const r: FakeRes = {
    statusCode: null, headers: {}, body: undefined,
    setHeader(k, v) { r.headers[k.toLowerCase()] = v; },
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
}

function req(ip = "203.0.113.7", path = "/") {
  return { socket: { remoteAddress: ip }, headers: {}, path } as never;
}

/** Run a middleware n times against the same caller, counting how many passed. */
function hammer(mw: ReturnType<typeof httpRateLimit>, n: number, ip = "203.0.113.7") {
  let passed = 0;
  let last = res();
  for (let i = 0; i < n; i++) {
    last = res();
    mw(req(ip), last as never, () => { passed++; });
  }
  return { passed, last };
}

beforeEach(() => resetRateLimits());

describe("httpRateLimit", () => {
  it("lets a normal caller through", () => {
    const { passed } = hammer(httpRateLimit("t:normal", RL_HTTP_OUTBOUND), 5);
    assert.equal(passed, 5);
  });

  it("refuses past the limit, with 429 and a Retry-After", () => {
    const mw = httpRateLimit("t:refuse", { limit: 3, windowMs: 60_000 });
    const { passed, last } = hammer(mw, 6);

    assert.equal(passed, 3, "only the first three should pass");
    assert.equal(last.statusCode, 429);
    assert.ok(Number(last.headers["retry-after"]) >= 1, "Retry-After must never be 0");
    assert.equal((last.body as { error: string }).error, "rate_limited");
  });

  it("counts each caller separately", () => {
    const mw = httpRateLimit("t:perip", { limit: 2, windowMs: 60_000 });
    hammer(mw, 5, "198.51.100.1");

    const { passed } = hammer(mw, 2, "198.51.100.2");
    assert.equal(passed, 2, "one caller being limited must not limit another");
  });

  /** The budgets differ by an order of magnitude, so a shared counter would let
      scrolling exhaust the upload budget and refuse image loads. */
  it("keeps separate budgets separate", () => {
    const upload = httpRateLimit("t:upload", RL_HTTP_UPLOAD);
    hammer(upload, RL_HTTP_UPLOAD.limit + 5);

    const { passed } = hammer(httpRateLimit("t:file", RL_HTTP_FILE), 10);
    assert.equal(passed, 10, "exhausting the upload budget must not touch the file budget");
  });

/** Staging and reading shared one key and the write rule carries a ban, so an
    import banned the address and took the emoji list down with it. */
  it("keeps reading an emoji list possible while writes are banned", () => {
    const writes = httpRateLimit("t:emoji:write", RL_HTTP_UPLOAD);
    hammer(writes, RL_HTTP_UPLOAD.limit + 20);

    const { passed } = hammer(httpRateLimit("t:emoji:read", RL_HTTP_API), 10);
    assert.equal(passed, 10, "a banned write budget must not refuse the list");
  });

  /** A burst is the normal shape here rather than abuse, so it answers 429 and
      lets the caller retry. */
  it("does not ban an address for staging emoji quickly", () => {
    assert.equal(RL_HTTP_EMOJI_WRITE.banMs, undefined);
    assert.ok(
      RL_HTTP_EMOJI_WRITE.limit > RL_HTTP_UPLOAD.limit,
      "a pack import is a legitimate burst and needs more room than a file upload",
    );
  });

  describe("while banned", () => {
    beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
    afterEach(() => mock.timers.reset());

    const retry = (r: FakeRes) => ({
      header: Number(r.headers["retry-after"]),
      ms: (r.body as { retryAfterMs: number }).retryAfterMs,
    });

    it("tells the caller the whole ban on the request that starts it", () => {
      const mw = httpRateLimit("t:ban:start", { limit: 2, windowMs: 10_000, banMs: 60_000 });
      const { last } = hammer(mw, 3);

      assert.equal(last.statusCode, 429);
      assert.deepEqual(retry(last), { header: 60, ms: 60_000 });
    });

    it("counts down the rest of the ban on later refusals", () => {
      const mw = httpRateLimit("t:ban:later", { limit: 2, windowMs: 10_000, banMs: 60_000 });
      hammer(mw, 3);

      mock.timers.tick(20_500);
      const { passed, last } = hammer(mw, 1);

      assert.equal(passed, 0);
      assert.deepEqual(retry(last), { header: 40, ms: 39_500 });
    });

    it("gives the ban rather than the score decay when a score rule bans", () => {
      const rule = { limit: 100, windowMs: 60_000, banMs: 30_000, scorePerAction: 1, maxScore: 2, scoreDecayMs: 1000 };
      const { last } = hammer(httpRateLimit("t:ban:score", rule), 3);

      assert.deepEqual(retry(last), { header: 30, ms: 30_000 });
    });

    it("lets the caller back in once the ban it was told about has passed", () => {
      const mw = httpRateLimit("t:ban:over", { limit: 2, windowMs: 10_000, banMs: 60_000 });
      const { last } = hammer(mw, 3);

      mock.timers.tick(retry(last).ms);
      assert.equal(hammer(mw, 1).passed, 1);
    });
  });

  it("reads the caller address from the socket when no proxy is trusted", () => {
    assert.equal(requestIp(req("203.0.113.9")), "203.0.113.9");
  });
});
