import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sniffMedia } from "./sniffMedia";

const b = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("sniffMedia", () => {
  it("knows each format the worker reads by its first bytes", () => {
    assert.equal(sniffMedia(b([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffMedia(b([0x89], "PNG\r\n\x1a\n")), "image/png");
    assert.equal(sniffMedia(b("GIF89a")), "image/gif");
    assert.equal(sniffMedia(b("RIFF", [0, 0, 0, 0], "WEBP")), "image/webp");
    assert.equal(sniffMedia(b([0, 0, 0, 0x1c], "ftypavif")), "image/avif");
    assert.equal(sniffMedia(b([0, 0, 0, 0x18], "ftypisom")), "video/mp4");
    assert.equal(sniffMedia(b([0, 0, 0, 0x14], "ftypqt  ")), "video/quicktime");
    assert.equal(sniffMedia(b([0x1a, 0x45, 0xdf, 0xa3])), "video/webm");
  });

  it("says nothing about everything else, so it stays a download", () => {
    assert.equal(sniffMedia(b("PK", [3, 4])), null);
    assert.equal(sniffMedia(b("%PDF-1.7")), null);
    assert.equal(sniffMedia(b("<svg")), null);
    assert.equal(sniffMedia(b("#EXTM3U\n")), null, "an HLS playlist named .mp4 is not a video");
    assert.equal(sniffMedia(new Uint8Array()), null);
  });
});
