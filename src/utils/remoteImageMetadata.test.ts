import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import sharp from "sharp";

import { createPublicOnlyAgent } from "./publicOnlyAgent";
import { fetchRemoteImageMetadata } from "./remoteImageMetadata";

/** `/api/media-metadata` fetched with `redirect: "follow"` behind a regex that only knew four ranges. */
describe("fetchRemoteImageMetadata", () => {
  let server: Server;
  let port: number;
  const hits: string[] = [];

  before(async () => {
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#123456" } }).png().toBuffer();
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/moved.png") {
        res.writeHead(302, { Location: `http://public.test:${port}/picture.png` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });

  after(() => server.close());

  it("refuses private addresses, including the v4-mapped spellings the old check let through", async () => {
    hits.length = 0;
    for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "169.254.169.254", "localhost"]) {
      const url = `http://${host}:${port}/picture.png`;
      assert.deepEqual(await fetchRemoteImageMetadata(url), { url, mime: null, width: null, height: null }, host);
    }
    assert.deepEqual(hits, []);
  });

  it("still reads the size of an allowed picture, through a redirect", async () => {
    hits.length = 0;
    const agent = createPublicOnlyAgent({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      allow: (address) => address === "127.0.0.1",
    });
    const url = `http://public.test:${port}/moved.png`;
    try {
      const meta = await fetchRemoteImageMetadata(url, { check: async () => ({ ok: true }), dispatcher: agent });
      assert.deepEqual(meta, { url, mime: "image/png", width: 30, height: 20 });
      assert.deepEqual(hits, ["/moved.png", "/picture.png"]);
    } finally {
      await agent.close();
    }
  });
});
