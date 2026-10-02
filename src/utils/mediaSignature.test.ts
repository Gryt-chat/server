import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaMimeFromHeader } from "./mediaSignature";

test("detects media headers without invoking a decoder or trusting a filename", () => {
  const examples: [Buffer, string][] = [
    [Buffer.from([255, 216, 255]), "image/jpeg"],
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"],
    [Buffer.from("GIF89a"), "image/gif"],
    [Buffer.from("RIFF0000WEBP"), "image/webp"],
    [Buffer.from([73, 73, 42, 0]), "image/tiff"],
    [Buffer.from("0000ftypavif"), "image/avif"],
    [Buffer.from("0000ftypheic"), "image/heif"],
    [Buffer.from("0000ftypisom"), "video/mp4"],
    [Buffer.from([26, 69, 223, 163]), "video/webm"],
  ];
  for (const [bytes, expected] of examples) assert.equal(mediaMimeFromHeader(bytes), expected);
  for (const bytes of [Buffer.alloc(0), Buffer.from("<svg/>"), Buffer.from("<script>alert(1)</script>"), Buffer.from("RIFF")]) assert.equal(mediaMimeFromHeader(bytes), null);
});
