import assert from "node:assert/strict";
import { test } from "node:test";

import { createPreviewImages, previewImageId } from "./previewImages";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function answer(body: Uint8Array<ArrayBuffer>, type: string, status = 200) {
  return { res: new Response(body, { status, headers: { "content-type": type } }), finalUrl: "https://example.com/a.png" };
}

test("only a URL a preview named can be loaded", async () => {
  const images = createPreviewImages(async () => answer(PNG, "image/png"));
  assert.equal(await images.load(previewImageId("https://example.com/a.png")), null, "an id nobody handed out was served");
  assert.equal(images.remember(null), null);
  const id = images.remember("https://example.com/a.png");
  assert.equal(id, previewImageId("https://example.com/a.png"));
  const got = await images.load(id!);
  assert.equal(got?.type, "image/png");
  assert.deepEqual(new Uint8Array(got!.body), PNG);
});

test("a picture is fetched once and then served from the cache", async () => {
  let fetches = 0;
  const images = createPreviewImages(async () => (fetches++, answer(PNG, "image/png")));
  const id = images.remember("https://example.com/a.png")!;
  await Promise.all([images.load(id), images.load(id)]);
  await images.load(id);
  assert.equal(fetches, 1);
});

test("SVG, HTML, errors, blocked hosts and oversized pictures are refused", async () => {
  const cases = [
    async () => answer(new Uint8Array(new TextEncoder().encode("<svg onload='x()'/>")), "image/svg+xml"),
    async () => answer(new Uint8Array(new TextEncoder().encode("<html></html>")), "text/html"),
    async () => answer(PNG, "image/png", 404),
    async () => ({ blocked: true as const }),
    async () => answer(new Uint8Array(5 * 1024 * 1024 + 1), "image/png"),
  ];
  for (const fetchOne of cases) {
    const images = createPreviewImages(fetchOne);
    assert.equal(await images.load(images.remember("https://example.com/x")!), null);
  }
});

test("the cache stays under its byte cap", async () => {
  const big = new Uint8Array(4 * 1024 * 1024);
  const images = createPreviewImages(async () => answer(big, "image/png"));
  for (let i = 0; i < 20; i++) await images.load(images.remember(`https://example.com/${i}.png`)!);
  assert.ok(images.cachedBytes() <= 64 * 1024 * 1024, `cached ${images.cachedBytes()} bytes`);
});
