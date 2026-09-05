import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { fetchFollowingSafely } from "./safePreviewFetch";
import type { UrlRejection } from "./previewUrlSafety";

/**
 * The property this exists for: a redirect to a blocked address is refused,
 * even when the URL first asked for was allowed.
 *
 * This is the bug it fixes. `/api/oembed` fetched the page a member named with
 * `redirect: "follow"`, so a page answering `302 -> 169.254.169.254` walked the
 * server onto an internal address the initial check had passed. The guard has
 * to apply to the address actually connected to, not only the first.
 *
 * The address check is injected so both hops can be loopback — a real redirect
 * *from* a public host is not something a hermetic test can stand up. The check
 * allows the first server and blocks the second, which is exactly the shape of
 * a public page redirecting somewhere internal.
 */
describe("fetchFollowingSafely", () => {
  let internal: Server;
  let internalUrl: string;
  let reachedInternal = false;

  let redirector: Server;
  let redirectorUrl: string;

  before(async () => {
    internal = createServer((_req, res) => {
      reachedInternal = true;
      res.end("internal-secret");
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
    internalUrl = `http://127.0.0.1:${(internal.address() as AddressInfo).port}/`;

    redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: internalUrl });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", () => r()));
    redirectorUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/`;
  });

  after(() => {
    internal.close();
    redirector.close();
  });

  const allowFirstBlockInternal = async (
    raw: string,
  ): Promise<{ ok: true } | { ok: false; reason: UrlRejection }> =>
    raw === internalUrl ? { ok: false, reason: "blocked_host" } : { ok: true };

  it("refuses a redirect to a blocked address and never connects to it", async () => {
    reachedInternal = false;
    const controller = new AbortController();

    const result = await fetchFollowingSafely(
      redirectorUrl,
      controller.signal,
      "text/html",
      allowFirstBlockInternal,
    );

    assert.deepEqual(result, { blocked: true });
    assert.equal(reachedInternal, false, "the blocked address must not be connected to");
  });

  it("would have reached it under a check that allows everything (the old behaviour)", async () => {
    // Proves the test's teeth: with a check that never blocks, the redirect is
    // followed and the internal server IS reached. So the assertion above is
    // catching the re-check, not passing for some unrelated reason.
    reachedInternal = false;
    const controller = new AbortController();

    const result = await fetchFollowingSafely(
      redirectorUrl,
      controller.signal,
      "text/html",
      async () => ({ ok: true }),
    );

    assert.ok("res" in result);
    if ("res" in result) await result.res.body?.cancel().catch(() => {});
    assert.equal(reachedInternal, true);
  });

  it("returns the response and the final url for an allowed request", async () => {
    reachedInternal = false;
    const controller = new AbortController();

    // Allow everything; the redirector points at `internal`, so the final hop
    // is `internalUrl` and that is what should come back as finalUrl.
    const result = await fetchFollowingSafely(
      redirectorUrl,
      controller.signal,
      "text/html",
      async () => ({ ok: true }),
    );

    assert.ok("res" in result);
    if ("res" in result) {
      await result.res.body?.cancel().catch(() => {});
      assert.equal(result.finalUrl, internalUrl);
    }
  });
});
