import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { httpRateLimit } from "../middleware/rateLimitHttp";
import type { LinkResolver } from "../utils/linkResolvers";
import { EMPTY_PAGE_METADATA } from "../utils/pageMetadata";
import { resetRateLimits } from "../utils/rateLimiter";
import { createPreviewCache, fetchPreview, type FetchPreviewDeps, type LinkPreviewData } from "./linkPreview";

const HOUR = 60 * 60 * 1000;

function card(url: string, title: string): LinkPreviewData {
  return { url, ...EMPTY_PAGE_METADATA, title, status: 200 };
}

/** Rejects once the signal aborts, the way real fetch does, and never answers otherwise. */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException("This operation was aborted", "AbortError"));
    signal.addEventListener("abort", () =>
      reject(new DOMException("This operation was aborted", "AbortError")),
    );
  });
}

function htmlPage(signal: AbortSignal, url: string) {
  if (signal.aborted) {
    return Promise.reject(new DOMException("This operation was aborted", "AbortError"));
  }
  const res = new Response("<html><head><title>The page</title></head></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  return Promise.resolve({ res, finalUrl: url });
}

function resolverThat(resolve: LinkResolver["resolve"]): LinkResolver {
  return { id: "hangs", hosts: ["example.com"], matches: () => true, resolve };
}

describe("fetchPreview", () => {
  const url = "https://example.com/thing";

  it("still fetches the page after a resolver's own fetch hangs", async () => {
    const deps: FetchPreviewDeps = {
      resolverFor: () => resolverThat((_u, fetchJson) => fetchJson("https://example.com/api") as never),
      fetchPage: (target, signal, accept) =>
        accept === "application/json" ? hangUntilAborted(signal) : htmlPage(signal, target),
      resolverTimeoutMs: 30,
      pageTimeoutMs: 2000,
    };

    const data = await fetchPreview(url, deps);
    assert.equal(data.title, "The page");
    assert.equal(data.status, 200);
  });

  it("gives up on a resolver that ignores the abort signal", async () => {
    const deps: FetchPreviewDeps = {
      resolverFor: () => resolverThat(() => new Promise(() => {})),
      fetchPage: (target, signal) => htmlPage(signal, target),
      resolverTimeoutMs: 30,
      pageTimeoutMs: 2000,
    };

    const data = await fetchPreview(url, deps);
    assert.equal(data.title, "The page");
  });

  describe("a Cloudflare challenge on the resolver's JSON call", () => {
    const challenge = () =>
      new Response("<html><head><title>Just a moment...</title></head></html>", {
        status: 403,
        headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" },
      });
    const design = () =>
      new Response(JSON.stringify({ title: "The model" }), {
        headers: { "content-type": "application/json" },
      });

    /** Hands out `answers` in order to JSON calls; the page itself is challenged too, as on MakerWorld. */
    function depsAnswering(answers: Array<() => Response>) {
      const calls = { json: 0, page: 0 };
      const bodies: Response[] = [];
      const deps: FetchPreviewDeps = {
        resolverFor: () =>
          resolverThat(async (_u, fetchJson) => {
            const json = (await fetchJson("https://example.com/api")) as { title?: string } | null;
            return json?.title ? { title: json.title } : null;
          }),
        fetchPage: async (target, _signal, accept) => {
          if (accept !== "application/json") {
            calls.page++;
            return { res: challenge(), finalUrl: target };
          }
          const next = answers[calls.json++];
          assert.ok(next, `unexpected JSON call ${calls.json}`);
          const res = next();
          bodies.push(res);
          return { res, finalUrl: target };
        },
        resolverTimeoutMs: 2000,
        pageTimeoutMs: 2000,
      };
      return { deps, calls, bodies };
    }

    it("retries once and gets the card", async () => {
      const { deps, calls, bodies } = depsAnswering([challenge, design]);
      const data = await fetchPreview(url, deps);

      assert.equal(data.title, "The model");
      assert.equal(data.status, 200);
      assert.equal(calls.json, 2);
      assert.equal(calls.page, 0);
      assert.ok(bodies[0].bodyUsed, "the challenge body is drained before the retry");
    });

    it("does not retry a second time", async () => {
      const { deps, calls } = depsAnswering([challenge, challenge, design]);
      const data = await fetchPreview(url, deps);

      assert.equal(calls.json, 2);
      assert.equal(data.title, null);
      assert.equal(data.status, 403);
    });

    it("does not retry a site's own 403", async () => {
      const forbidden = () =>
        new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
      const { deps, calls } = depsAnswering([forbidden, design]);
      await fetchPreview(url, deps);

      assert.equal(calls.json, 1);
    });
  });
});

describe("createPreviewCache", () => {
  const url = "https://example.com/a";

  it("makes one upstream fetch for concurrent requests of one URL", async () => {
    let fetches = 0;
    let charges = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const previews = createPreviewCache(async (u) => {
      fetches++;
      await gate;
      return card(u, "A");
    });

    const pending = Array.from({ length: 10 }, () =>
      previews.lookup(url, () => {
        charges++;
        return true;
      }),
    );
    release();
    const results = await Promise.all(pending);

    assert.equal(fetches, 1);
    assert.equal(charges, 1, "joining a fetch in flight must not be charged");
    for (const r of results) assert.equal("data" in r && r.data.title, "A");

    // Settled, so the next miss fetches again rather than reusing the old promise.
    const later = createPreviewCache(async (u) => {
      fetches++;
      throw new Error(`down ${u}`);
    });
    await later.lookup(url, () => true);
    await later.lookup(url, () => true);
    assert.equal(fetches, 3, "a failure is neither cached nor left in flight");
  });

  it("answers with the previous card when a refresh fails", async () => {
    let clock = 0;
    let fail = false;
    const previews = createPreviewCache(
      async (u) => {
        if (fail) throw new Error("This operation was aborted");
        return card(u, "Old");
      },
      () => clock,
    );

    await previews.lookup(url, () => true);
    clock += 2 * HOUR;
    fail = true;

    const refreshed = await previews.lookup(url, () => true);
    assert.deepEqual(refreshed, { data: card(url, "Old"), stale: true });

    clock += 23 * HOUR;
    const expired = await previews.lookup(url, () => true);
    assert.ok("failed" in expired, "past a day the old card is no longer an answer");
  });

  it("keeps a refusal for minutes, not the hour, and never serves it as stale", async () => {
    let clock = 0;
    let fetches = 0;
    let fail = false;
    const refused: LinkPreviewData = { url, ...EMPTY_PAGE_METADATA, status: 403 };
    const previews = createPreviewCache(
      async () => {
        fetches++;
        if (fail) throw new Error("This operation was aborted");
        return refused;
      },
      () => clock,
    );

    await previews.lookup(url, () => true);
    clock += 4 * 60 * 1000;
    assert.deepEqual(await previews.lookup(url, () => true), { data: refused, stale: false });
    assert.equal(fetches, 1);

    clock += 2 * 60 * 1000;
    fail = true;
    const retried = await previews.lookup(url, () => true);
    assert.equal(fetches, 2, "past five minutes a refusal is fetched again");
    assert.ok("failed" in retried, "a refusal is not the previous card");

    previews.sweep();
    assert.equal(previews.size(), 0);
  });

  it("sweeps entries older than a day and keeps younger stale ones", async () => {
    let clock = 0;
    const previews = createPreviewCache(async (u) => card(u, "A"), () => clock);
    await previews.lookup("https://example.com/old", () => true);
    clock += 20 * HOUR;
    await previews.lookup("https://example.com/young", () => true);
    clock += 5 * HOUR;

    previews.sweep();
    assert.equal(previews.size(), 1);
  });

  describe("with the real limiter", () => {
    beforeEach(() => resetRateLimits());

    function charger(limit: ReturnType<typeof httpRateLimit>) {
      const req = { socket: { remoteAddress: "203.0.113.9" }, headers: {} } as never;
      const res = { statusCode: 0, setHeader() {}, status(c: number) { res.statusCode = c; return res; }, json() { return res; } };
      return {
        res,
        charge: () => {
          let allowed = false;
          limit(req, res as never, () => (allowed = true));
          return allowed;
        },
      };
    }

    it("does not spend the limit on a cache hit", async () => {
      const previews = createPreviewCache(async (u) => card(u, "A"));
      const { res, charge } = charger(httpRateLimit("t:preview", { limit: 2, windowMs: 60_000 }));

      await previews.lookup(url, charge);
      for (let i = 0; i < 30; i++) {
        const hit = await previews.lookup(url, charge);
        assert.ok("data" in hit);
      }
      assert.equal(res.statusCode, 0);

      assert.ok("data" in (await previews.lookup("https://example.com/b", charge)));
      assert.deepEqual(await previews.lookup("https://example.com/c", charge), { refused: true });
      assert.equal(res.statusCode, 429);
    });
  });
});
