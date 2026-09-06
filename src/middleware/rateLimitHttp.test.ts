import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

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

  /**
   * The budgets differ by an order of magnitude on purpose, so they must not
   * share a counter. Reading attachments while scrolling would otherwise
   * exhaust the upload budget and start refusing image loads.
   */
  it("keeps separate budgets separate", () => {
    const upload = httpRateLimit("t:upload", RL_HTTP_UPLOAD);
    hammer(upload, RL_HTTP_UPLOAD.limit + 5);

    const { passed } = hammer(httpRateLimit("t:file", RL_HTTP_FILE), 10);
    assert.equal(passed, 10, "exhausting the upload budget must not touch the file budget");
  });

  /**
   * The emoji incident, as a test.
   *
   * Staging an emoji and reading the emoji list shared one key, and the write
   * rule carries a ban. So importing a pack — one request per emoji, six at a
   * time — spent the budget, banned the address, and the ban refused the list
   * as well. A client with no list draws no emoji, so a server halfway through
   * an import was indistinguishable from one whose emoji had been deleted.
   */
  it("keeps reading an emoji list possible while writes are banned", () => {
    const writes = httpRateLimit("t:emoji:write", RL_HTTP_UPLOAD);
    hammer(writes, RL_HTTP_UPLOAD.limit + 20);

    const { passed } = hammer(httpRateLimit("t:emoji:read", RL_HTTP_API), 10);
    assert.equal(passed, 10, "a banned write budget must not refuse the list");
  });

  /**
   * A burst is the normal shape of this endpoint rather than a sign of abuse,
   * so it answers 429 and lets the caller retry instead of shutting the address
   * out for another window.
   */
  it("does not ban an address for staging emoji quickly", () => {
    assert.equal(RL_HTTP_EMOJI_WRITE.banMs, undefined);
    assert.ok(
      RL_HTTP_EMOJI_WRITE.limit > RL_HTTP_UPLOAD.limit,
      "a pack import is a legitimate burst and needs more room than a file upload",
    );
  });

  it("reads the caller address from the socket when no proxy is trusted", () => {
    assert.equal(requestIp(req("203.0.113.9")), "203.0.113.9");
  });
});
