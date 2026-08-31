import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { resetRateLimits } from "../utils/rateLimiter";
import { httpRateLimit, requestIp, RL_HTTP_FILE, RL_HTTP_OUTBOUND, RL_HTTP_UPLOAD } from "./rateLimitHttp";

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

  it("reads the caller address from the socket when no proxy is trusted", () => {
    assert.equal(requestIp(req("203.0.113.9")), "203.0.113.9");
  });
});
