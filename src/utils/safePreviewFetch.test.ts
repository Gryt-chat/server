import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { isIP, type AddressInfo, type LookupFunction } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";

import { Agent } from "undici";

import { checkPreviewUrl, type UrlRejection } from "./previewUrlSafety";
import { createPublicOnlyAgent, isBlockedAddressError, type Resolve } from "./publicOnlyAgent";
import { fetchFollowingSafely, type FetchGuard } from "./safePreviewFetch";

type RecordingResolve = Resolve & { asked: string[] };

/** Answers in turn and then repeats the last one, like a rebinding server with a zero TTL. */
function answersInTurn(...answers: string[][]): RecordingResolve {
  const asked: string[] = [];
  const resolve: Resolve = async (hostname) => {
    const answer = answers[Math.min(asked.length, answers.length - 1)];
    asked.push(hostname);
    return answer.map((address) => ({ address, family: isIP(address) }));
  };
  return Object.assign(resolve, { asked });
}

function answersByName(table: Record<string, string[]>): RecordingResolve {
  const asked: string[] = [];
  const resolve: Resolve = async (hostname) => {
    asked.push(hostname);
    const answer = table[hostname];
    if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return answer.map((address) => ({ address, family: isIP(address) }));
  };
  return Object.assign(resolve, { asked });
}

const anyUrl = async (): Promise<{ ok: true }> => ({ ok: true });

/** A local server has to stand in for a public host somewhere, and 127.0.0.1 is that stand-in. */
const loopbackCountsAsPublic = (address: string) => address === "127.0.0.1";

async function listen(server: Server | TlsServer): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
}

describe("fetchFollowingSafely", () => {
  let internal: Server;
  let internalPort: number;
  let internalUrl: string;
  const internalHits: { host: string | undefined }[] = [];

  let redirector: Server;
  let redirectorUrl: string;
  let redirectTo = "";

  const agents: Agent[] = [];
  function agent(made: Agent): Agent {
    agents.push(made);
    return made;
  }

  before(async () => {
    internal = createServer((req, res) => {
      internalHits.push({ host: req.headers.host });
      res.end("internal-secret");
    });
    internalPort = await listen(internal);
    internalUrl = `http://127.0.0.1:${internalPort}/`;

    redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: redirectTo });
      res.end();
    });
    redirectorUrl = `http://127.0.0.1:${await listen(redirector)}/`;
  });

  afterEach(async () => {
    internalHits.length = 0;
    await Promise.all(agents.splice(0).map((a) => a.close()));
  });

  after(() => {
    internal.close();
    redirector.close();
  });

  describe("the redirect re-check", () => {
    const allowFirstBlockInternal = async (
      raw: string,
    ): Promise<{ ok: true } | { ok: false; reason: UrlRejection }> =>
      raw === internalUrl ? { ok: false, reason: "blocked_host" } : { ok: true };

    it("refuses a redirect to a blocked address and never connects to it", async () => {
      redirectTo = internalUrl;
      const guard: FetchGuard = {
        check: allowFirstBlockInternal,
        dispatcher: agent(createPublicOnlyAgent({ allow: loopbackCountsAsPublic })),
      };

      const result = await fetchFollowingSafely(redirectorUrl, AbortSignal.timeout(5000), "text/html", guard);

      assert.deepEqual(result, { blocked: true });
      assert.equal(internalHits.length, 0, "the blocked address must not be connected to");
    });

    it("would have reached it under a check that allows everything (the old behaviour)", async () => {
      // So the assertion above is catching the re-check and not something else.
      redirectTo = internalUrl;
      const guard: FetchGuard = {
        check: anyUrl,
        dispatcher: agent(createPublicOnlyAgent({ allow: loopbackCountsAsPublic })),
      };

      const result = await fetchFollowingSafely(redirectorUrl, AbortSignal.timeout(5000), "text/html", guard);

      assert.ok("res" in result);
      await result.res.body?.cancel().catch(() => {});
      assert.equal(result.finalUrl, internalUrl);
      assert.equal(internalHits.length, 1);
    });
  });

  describe("the connection", () => {
    it("refuses the second answer when the first one passed the check (DNS rebinding)", async () => {
      const resolve = answersInTurn(["93.184.215.14"], ["127.0.0.1"]);
      const guard: FetchGuard = {
        check: (raw) => checkPreviewUrl(raw, resolve),
        dispatcher: agent(createPublicOnlyAgent({ resolve })),
      };

      const result = await fetchFollowingSafely(`http://rebind.test:${internalPort}/`, AbortSignal.timeout(5000), "text/html", guard);

      assert.deepEqual(result, { blocked: true });
      assert.equal(internalHits.length, 0);
      assert.deepEqual(resolve.asked, ["rebind.test", "rebind.test"], "the check and the connection each asked once");
    });

    it("reaches the internal server when only the check looks at the answer (the old behaviour)", async () => {
      const resolve = answersInTurn(["93.184.215.14"], ["127.0.0.1"]);
      const unchecked: LookupFunction = (hostname, options, callback) => {
        void resolve(hostname, {}).then((addresses) =>
          options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        );
      };
      const guard: FetchGuard = {
        check: (raw) => checkPreviewUrl(raw, resolve),
        dispatcher: agent(new Agent({ connect: { lookup: unchecked } })),
      };

      const result = await fetchFollowingSafely(`http://rebind.test:${internalPort}/`, AbortSignal.timeout(5000), "text/html", guard);

      assert.ok("res" in result);
      assert.equal(await result.res.text(), "internal-secret");
      assert.equal(internalHits.length, 1);
    });

    it("refuses a name that only ever resolves to a private address", async () => {
      for (const answer of [["127.0.0.1"], ["10.0.0.1"], ["169.254.169.254"], ["::1"]]) {
        const resolve = answersInTurn(answer);
        const guard: FetchGuard = { check: anyUrl, dispatcher: agent(createPublicOnlyAgent({ resolve })) };

        const result = await fetchFollowingSafely(`http://private.test:${internalPort}/`, AbortSignal.timeout(5000), "text/html", guard);

        assert.deepEqual(result, { blocked: true }, answer[0]);
      }
      assert.equal(internalHits.length, 0);
    });

    it("refuses a v4-mapped IPv6 answer that points at the loopback", async () => {
      for (const answer of [["::ffff:127.0.0.1"], ["::ffff:7f00:1"]]) {
        const resolve = answersInTurn(answer);
        const guard: FetchGuard = { check: anyUrl, dispatcher: agent(createPublicOnlyAgent({ resolve })) };

        const result = await fetchFollowingSafely(`http://mapped.test:${internalPort}/`, AbortSignal.timeout(5000), "text/html", guard);

        assert.deepEqual(result, { blocked: true }, answer[0]);
      }
      assert.equal(internalHits.length, 0);
    });

    it("refuses when any one of several answers is private", async () => {
      const resolve = answersInTurn(["127.0.0.1", "10.0.0.1"]);
      const guard: FetchGuard = {
        check: anyUrl,
        dispatcher: agent(createPublicOnlyAgent({ resolve, allow: loopbackCountsAsPublic })),
      };

      const result = await fetchFollowingSafely(`http://mixed.test:${internalPort}/`, AbortSignal.timeout(5000), "text/html", guard);

      assert.deepEqual(result, { blocked: true });
      assert.equal(internalHits.length, 0, "127.0.0.1 was allowed, but it came with 10.0.0.1");
    });

    it("refuses a literal private address, which never goes through lookup", async () => {
      const resolve = answersInTurn(["93.184.215.14"]);
      const guard: FetchGuard = { check: anyUrl, dispatcher: agent(createPublicOnlyAgent({ resolve })) };

      const result = await fetchFollowingSafely(internalUrl, AbortSignal.timeout(5000), "text/html", guard);

      assert.deepEqual(result, { blocked: true });
      assert.equal(internalHits.length, 0);
      assert.deepEqual(resolve.asked, []);
    });

    it("refuses a redirect hop whose name resolves privately, even past a check that allows it", async () => {
      redirectTo = `http://internal.test:${internalPort}/`;
      const resolve = answersByName({ "public.test": ["127.0.0.1"], "internal.test": ["::ffff:127.0.0.1"] });
      const guard: FetchGuard = {
        check: anyUrl,
        dispatcher: agent(createPublicOnlyAgent({ resolve, allow: loopbackCountsAsPublic })),
      };
      const start = redirectorUrl.replace("127.0.0.1", "public.test");

      const result = await fetchFollowingSafely(start, AbortSignal.timeout(5000), "text/html", guard);

      assert.deepEqual(result, { blocked: true });
      assert.equal(internalHits.length, 0);
      assert.deepEqual(resolve.asked, ["public.test", "internal.test"]);
    });

    it("fetches an allowed name with its own Host header, connecting to the address it checked", async () => {
      redirectTo = `http://public.test:${internalPort}/page`;
      const resolve = answersByName({ "public.test": ["127.0.0.1"] });
      const guard: FetchGuard = {
        check: anyUrl,
        dispatcher: agent(createPublicOnlyAgent({ resolve, allow: loopbackCountsAsPublic })),
      };
      const start = redirectorUrl.replace("127.0.0.1", "public.test");

      const result = await fetchFollowingSafely(start, AbortSignal.timeout(5000), "text/html", guard);

      assert.ok("res" in result);
      assert.equal(result.res.status, 200);
      assert.equal(await result.res.text(), "internal-secret");
      assert.equal(result.finalUrl, redirectTo);
      assert.deepEqual(internalHits, [{ host: `public.test:${internalPort}` }]);
    });

    it("sends the name, not the address, as TLS SNI", async () => {
      const servernames: string[] = [];
      const tls = createTlsServer({
        SNICallback: (servername, done) => {
          servernames.push(servername);
          done(new Error("no certificate here"));
        },
      });
      const port = await listen(tls);
      const resolve = answersByName({ "secure.test": ["127.0.0.1"] });
      const guard: FetchGuard = {
        check: anyUrl,
        dispatcher: agent(createPublicOnlyAgent({ resolve, allow: loopbackCountsAsPublic })),
      };

      try {
        await assert.rejects(
          fetchFollowingSafely(`https://secure.test:${port}/`, AbortSignal.timeout(5000), "text/html", guard),
          (err) => !isBlockedAddressError(err),
        );
      } finally {
        tls.close();
      }

      assert.deepEqual(servernames, ["secure.test"]);
      assert.deepEqual(resolve.asked, ["secure.test"]);
    });
  });
});
