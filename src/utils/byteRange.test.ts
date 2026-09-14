import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSingleByteRange, resolveByteRange } from "./byteRange";

const MB = 1024 * 1024;

describe("resolveByteRange", () => {
  it("clamps a last byte past the end", () => {
    // Chrome gave up on a video whose Content-Range ran past the file.
    assert.deepEqual(resolveByteRange("bytes=0-99999999", MB), { kind: "partial", start: 0, end: MB - 1 });
    assert.deepEqual(resolveByteRange("bytes=100-1048576", MB), { kind: "partial", start: 100, end: MB - 1 });
  });

  it("keeps a range that fits", () => {
    assert.deepEqual(resolveByteRange("bytes=0-0", MB), { kind: "partial", start: 0, end: 0 });
    assert.deepEqual(resolveByteRange("bytes=10-19", MB), { kind: "partial", start: 10, end: 19 });
    assert.deepEqual(resolveByteRange("bytes=0-1048575", MB), { kind: "partial", start: 0, end: MB - 1 });
  });

  it("serves an open-ended range to the end", () => {
    assert.deepEqual(resolveByteRange("bytes=500-", MB), { kind: "partial", start: 500, end: MB - 1 });
    assert.deepEqual(resolveByteRange("bytes=1048575-", MB), { kind: "partial", start: MB - 1, end: MB - 1 });
  });

  it("reads a suffix range as the last N bytes", () => {
    assert.deepEqual(resolveByteRange("bytes=-500", MB), { kind: "partial", start: MB - 500, end: MB - 1 });
    assert.deepEqual(resolveByteRange("bytes=-99999999", MB), { kind: "partial", start: 0, end: MB - 1 });
  });

  it("refuses a first byte at or past the end", () => {
    for (const header of ["bytes=1048576-", "bytes=1048576-2000000", "bytes=99999999-", "bytes=99999999999999999999999-"]) {
      assert.deepEqual(resolveByteRange(header, MB), { kind: "unsatisfiable" }, header);
    }
  });

  it("refuses a zero suffix, and any range of an empty file", () => {
    assert.deepEqual(resolveByteRange("bytes=-0", MB), { kind: "unsatisfiable" });
    assert.deepEqual(resolveByteRange("bytes=0-", 0), { kind: "unsatisfiable" });
    assert.deepEqual(resolveByteRange("bytes=-5", 0), { kind: "unsatisfiable" });
  });

  it("ignores malformed and multi-range headers", () => {
    for (const header of [
      undefined,
      "",
      "bytes=",
      "bytes=-",
      "bytes=abc",
      "bytes=5-3",
      "bytes=0-1,5-6",
      "bytes=0-1, 5-6",
      "items=0-5",
      "bytes 0-5",
      "bytes=0x10-20",
      "bytes=1.5-3",
    ]) {
      assert.deepEqual(resolveByteRange(header, MB), { kind: "full" }, String(header));
      assert.equal(isSingleByteRange(header), false, String(header));
    }
  });

  it("accepts the unit in any case and whitespace around the range", () => {
    assert.deepEqual(resolveByteRange("Bytes=0-9", MB), { kind: "partial", start: 0, end: 9 });
    assert.deepEqual(resolveByteRange("bytes= 0-9 ", MB), { kind: "partial", start: 0, end: 9 });
  });
});
