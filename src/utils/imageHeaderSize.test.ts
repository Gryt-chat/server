import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { imageHeaderSize } from "./imageHeaderSize";

/* GRYT-1664: link previews read a stranger's picture, so the server takes its size from the
   header and never decodes it. The pictures here are made by sharp only to have real headers. */
describe("imageHeaderSize", () => {
  const make = (format: "png" | "jpeg" | "gif" | "webp", lossless = false) =>
    sharp({ create: { width: 333, height: 177, channels: 3, background: "#4a8" } })[format](format === "webp" ? { lossless } : {}).toBuffer();

  for (const [name, f, lossless] of [["PNG", "png"], ["JPEG", "jpeg"], ["GIF", "gif"], ["lossy WebP", "webp", false], ["lossless WebP", "webp", true]] as const) {
    it(`reads a ${name}'s size`, async () => {
      assert.deepEqual(imageHeaderSize(await make(f, lossless)), { width: 333, height: 177 });
    });
  }

  it("answers null for anything else, or a header that lies", () => {
    assert.equal(imageHeaderSize(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
    assert.equal(imageHeaderSize(Buffer.alloc(0)), null);
    const zero = Buffer.alloc(24);
    zero.writeUInt32BE(0x89504e47, 0);
    zero.write("IHDR", 12, "latin1");
    assert.equal(imageHeaderSize(zero), null, "a zero-sized PNG is not believed");
  });
});
