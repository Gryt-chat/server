import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { rasterHeaderDimensions } from "./rasterHeaderDimensions";
import { readUpToBytes } from "./remoteImageMetadata";

test("reads layout dimensions without decoding PNG, JPEG, GIF or WebP", async () => {
  for (const format of ["png", "jpeg", "gif", "webp"] as const) {
    const source = sharp({ create: { width: 30, height: 20, channels: 3, background: "red" } });
    const bytes = await source[format]().toBuffer();
    assert.deepEqual(rasterHeaderDimensions(bytes), { width: 30, height: 20 }, format);
    for (let size = 0; size < Math.min(bytes.length, 80); size++) {
      assert.doesNotThrow(() => rasterHeaderDimensions(bytes.subarray(0, size)), `${format}, ${size} bytes`);
    }
  }
  const lossless = await sharp({ create: { width: 80, height: 40, channels: 3, background: "blue" } }).webp({ lossless: true }).toBuffer();
  assert.deepEqual(rasterHeaderDimensions(lossless), { width: 80, height: 40 });
  const extended = Buffer.alloc(30);
  extended.write("RIFF", 0);
  extended.write("WEBPVP8X", 8);
  extended.writeUInt32LE(10, 16);
  extended.writeUIntLE(99, 24, 3);
  extended.writeUIntLE(69, 27, 3);
  assert.deepEqual(rasterHeaderDimensions(extended), { width: 100, height: 70 });
});

test("rejects zero, oversized and malformed dimension headers", () => {
  assert.equal(rasterHeaderDimensions(Buffer.from("not an image")), null);
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000000000000", "hex");
  assert.equal(rasterHeaderDimensions(png), null);
  png.writeUInt32BE(100_000, 16);
  png.writeUInt32BE(100_000, 20);
  assert.equal(rasterHeaderDimensions(png), null);
  assert.equal(rasterHeaderDimensions(Buffer.from("ffd8ffe00000", "hex")), null);
  assert.equal(rasterHeaderDimensions(Buffer.from("ffd8ffe0ffff", "hex")), null);
});

test("bounds retained bytes even when the remote stream yields an oversized chunk", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1_000_000)); },
    cancel() { cancelled = true; },
  });
  assert.equal((await readUpToBytes(new Response(stream), 450_000))?.length, 450_000);
  assert.equal(cancelled, true);
});
