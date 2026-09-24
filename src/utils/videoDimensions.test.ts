import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  bufferSource,
  PARSE_LIMITS,
  readVideoDimensions,
  readVideoDimensionsFromFile,
  type ByteSource,
} from "./videoDimensions";

// One-frame files made with ffmpeg 8; `rotated.mov` is landscape.mp4 with a 90° display matrix.
const fixtures: Array<[file: string, width: number, height: number]> = [
  ["landscape.mp4", 160, 90],
  ["portrait-faststart.mp4", 90, 160],
  ["rotated.mov", 90, 160],
  ["anamorphic.webm", 240, 120],
  ["streamed.webm", 120, 160],
];

const fixture = (name: string) => readFileSync(join(__dirname, "testdata", name));

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/** A version 0 tkhd: 40 bytes up to the matrix, 36 of matrix, then 16.16 width and height. */
function tkhd(width: number, height: number, quarterTurn = false): Buffer {
  const b = Buffer.alloc(84);
  const m = 40;
  b.writeInt32BE(quarterTurn ? 0 : 0x10000, m);
  b.writeInt32BE(quarterTurn ? 0x10000 : 0, m + 4);
  b.writeInt32BE(quarterTurn ? -0x10000 : 0, m + 12);
  b.writeInt32BE(quarterTurn ? 0 : 0x10000, m + 16);
  b.writeInt32BE(0x40000000, m + 32);
  b.writeUInt32BE(width * 65536, m + 36);
  b.writeUInt32BE(height * 65536, m + 40);
  return box("tkhd", b);
}

function hdlr(kind: string): Buffer {
  const b = Buffer.alloc(24);
  b.write(kind, 8, "latin1");
  return box("hdlr", b);
}

function mp4(...traks: Buffer[]): Buffer {
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", ...traks)]);
}

const trak = (kind: string, width: number, height: number, quarterTurn = false) =>
  box("trak", tkhd(width, height, quarterTurn), box("mdia", hdlr(kind)));

/** Counts reads so a test can see the parser stopped rather than only that it returned. */
function counting(buf: Buffer): ByteSource & { reads: number; bytes: number } {
  const inner = bufferSource(buf);
  const src = {
    size: inner.size,
    reads: 0,
    bytes: 0,
    read: (offset: number, length: number) => {
      src.reads++;
      src.bytes += length;
      return inner.read(offset, length);
    },
  };
  return src;
}

/** An EBML element with a one-byte size, which is all these tests need. */
function el(id: number[], ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  assert.ok(body.length < 127);
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | body.length]), body]);
}

const uint = (id: number[], value: number) => el(id, Buffer.from([value >> 8, value & 0xff]));

function webm(tracks: Buffer): Buffer {
  const unknownSize = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  return Buffer.concat([el([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from([0x18, 0x53, 0x80, 0x67]), unknownSize, tracks]);
}

const TRACKS = [0x16, 0x54, 0xae, 0x6b];
const trackType = (type: number) => el([0x83], Buffer.from([type]));
const pixelWidth = (n: number) => uint([0xb0], n);
const pixelHeight = (n: number) => uint([0xba], n);

describe("readVideoDimensions", () => {
  for (const [file, width, height] of fixtures) {
    it(`reads ${file} as ${width}x${height}`, async () => {
      assert.deepEqual(await readVideoDimensions(bufferSource(fixture(file))), { width, height });
    });
  }

  it("finds moov after mdat without reading mdat", async () => {
    const buf = fixture("landscape.mp4");
    assert.ok(buf.indexOf("moov") > buf.indexOf("mdat"), "fixture no longer has moov last");
    assert.deepEqual(await readVideoDimensions(bufferSource(buf)), { width: 160, height: 90 });
  });

  it("reads the same through a file handle", async () => {
    const got = await readVideoDimensionsFromFile(join(__dirname, "testdata", "rotated.mov"));
    assert.deepEqual(got, { width: 90, height: 160 });
  });

  it("answers null for a path that is not there", async () => {
    assert.equal(await readVideoDimensionsFromFile(join(__dirname, "testdata", "missing.mp4")), null);
  });

  it("refuses every truncation cleanly", async () => {
    for (const [file, width, height] of fixtures) {
      const buf = fixture(file);
      for (let cut = 0; cut < buf.length; cut++) {
        const got = await readVideoDimensions(bufferSource(buf.subarray(0, cut)));
        // A cut after the headers still has the answer in it; anything else must be null.
        if (got !== null) assert.deepEqual(got, { width, height }, `${file} cut at ${cut}`);
      }
    }
  });

  it("never throws on corrupted bytes, and never answers outside the limits", async () => {
    let seed = 1309;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (const [file] of fixtures) {
      const original = fixture(file);
      for (let round = 0; round < 300; round++) {
        const buf = Buffer.from(original);
        for (let flips = 0; flips < 4; flips++) buf[next() % buf.length] = next() % 256;
        const got = await readVideoDimensions(bufferSource(buf));
        if (got === null) continue;
        assert.ok(Number.isInteger(got.width) && Number.isInteger(got.height));
        assert.ok(got.width >= 1 && got.width <= PARSE_LIMITS.maxSide);
        assert.ok(got.height >= 1 && got.height <= PARSE_LIMITS.maxSide);
      }
    }
  });

  it("answers null for things that are not videos", async () => {
    for (const buf of [
      Buffer.alloc(0),
      Buffer.from("hello"),
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
      Buffer.alloc(4096),
    ]) {
      assert.equal(await readVideoDimensions(bufferSource(buf)), null);
    }
  });

  it("skips an audio track and reads the video one after it", async () => {
    const buf = mp4(trak("soun", 0, 0), trak("vide", 1920, 1080));
    assert.deepEqual(await readVideoDimensions(bufferSource(buf)), { width: 1920, height: 1080 });
  });

  it("answers null for an audio-only file", async () => {
    assert.equal(await readVideoDimensions(bufferSource(mp4(trak("soun", 0, 0)))), null);
  });

  it("does not take a size from a track that is not video", async () => {
    // A subtitle or timecode track can carry a width, and it is not the picture's.
    assert.equal(await readVideoDimensions(bufferSource(mp4(trak("text", 640, 80)))), null);
  });

  it("swaps width and height for a quarter turn", async () => {
    const buf = mp4(trak("vide", 1920, 1080, true));
    assert.deepEqual(await readVideoDimensions(bufferSource(buf)), { width: 1080, height: 1920 });
  });

  it("refuses zero and oversized dimensions", async () => {
    assert.equal(await readVideoDimensions(bufferSource(mp4(trak("vide", 0, 1080)))), null);
    assert.equal(await readVideoDimensions(bufferSource(mp4(trak("vide", 40_000, 1080)))), null);
  });

  it("refuses a box that claims to be larger than its parent", async () => {
    const buf = mp4(trak("vide", 1920, 1080));
    // moov starts after the 20-byte ftyp; make it claim four gigabytes.
    buf.writeUInt32BE(0xffffffff, 20);
    assert.equal(await readVideoDimensions(bufferSource(buf)), null);
  });

  it("refuses a 64-bit box size past what a number holds", async () => {
    const huge = Buffer.alloc(16);
    huge.writeUInt32BE(1, 0);
    huge.write("moov", 4, "latin1");
    huge.writeUInt32BE(0xffffffff, 8);
    huge.writeUInt32BE(0xffffffff, 12);
    const buf = Buffer.concat([box("ftyp", Buffer.from("isom")), huge, Buffer.alloc(64)]);
    assert.equal(await readVideoDimensions(bufferSource(buf)), null);
  });

  it("stops after the element budget on a file of empty boxes", async () => {
    const filler = Buffer.concat(Array.from({ length: 50_000 }, () => box("free")));
    const src = counting(Buffer.concat([box("ftyp", Buffer.from("isom")), filler, mp4(trak("vide", 64, 64))]));
    assert.equal(await readVideoDimensions(src), null);
    assert.ok(src.reads <= PARSE_LIMITS.maxElements, `read ${src.reads} times`);
  });

  it("refuses a WebM Tracks element over its size cap without reading it", async () => {
    // An 8-byte size: the 0x01 marker, then seven bytes holding one past the cap.
    const size = Buffer.alloc(8);
    size[0] = 0x01;
    size.writeUIntBE(PARSE_LIMITS.maxTracksBytes + 1, 2, 6);
    const src = counting(webm(Buffer.concat([Buffer.from(TRACKS), size, Buffer.alloc(PARSE_LIMITS.maxTracksBytes + 1)])));
    assert.equal(await readVideoDimensions(src), null);
    assert.ok(src.bytes < 1024, `read ${src.bytes} bytes`);
  });

  it("reads a WebM built by hand, skipping an audio track", async () => {
    const buf = webm(
      el(TRACKS, el([0xae], trackType(2)), el([0xae], trackType(1), el([0xe0], pixelWidth(640), pixelHeight(360)))),
    );
    assert.deepEqual(await readVideoDimensions(bufferSource(buf)), { width: 640, height: 360 });
  });

  it("does not read past the end of a WebM element into its sibling", async () => {
    // Video claims PixelHeight too, but PixelHeight sits outside the TrackEntry.
    const video = Buffer.concat([Buffer.from([0xe0, 0x80 | 8]), pixelWidth(640)]);
    const entry = el([0xae], trackType(1), video);
    const buf = webm(el(TRACKS, entry, pixelHeight(360)));
    assert.equal(await readVideoDimensions(bufferSource(buf)), null);
  });

  it("stops at the first WebM Cluster rather than walking the whole file", async () => {
    const tracks = el(TRACKS, el([0xae], trackType(1), el([0xe0], pixelWidth(640), pixelHeight(360))));
    const buf = webm(Buffer.concat([el([0x1f, 0x43, 0xb6, 0x75], Buffer.alloc(16)), tracks]));
    assert.equal(await readVideoDimensions(bufferSource(buf)), null);
  });

  it("refuses a WebM Tracks element whose children overrun it", async () => {
    const buf = Buffer.from(fixture("anamorphic.webm"));
    const entry = buf.indexOf(Buffer.from([0xae]), buf.indexOf(Buffer.from([0x16, 0x54, 0xae, 0x6b])) + 4);
    assert.ok(entry > 0);
    // TrackEntry's one-byte size, turned up past the end of Tracks.
    buf[entry + 1] = 0xfe;
    assert.equal(await readVideoDimensions(bufferSource(buf)), null);
  });
});
