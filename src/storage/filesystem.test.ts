import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Readable } from "node:stream";

import { RangeNotSatisfiableError } from "../utils/byteRange";
import { getObject, initFilesystem, putObject } from "./filesystem";

const SIZE = 1024 * 1024;
const bucket = "uploads";
const key = "uploads/video.bin";
const data = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) data[i] = i % 251;

async function read(body: Readable | undefined): Promise<Buffer> {
  assert.ok(body, "no body");
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("filesystem getObject with a Range", () => {
  let dir: string;
  const previous = process.env.DATA_DIR;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "gryt-range-"));
    process.env.DATA_DIR = dir;
    initFilesystem();
    await putObject({ bucket, key, body: data, contentType: "video/mp4" });
    await putObject({ bucket, key: "uploads/empty.bin", body: Buffer.alloc(0) });
  });

  after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const partial: Array<[string, number, number]> = [
    ["bytes=0-99999999", 0, SIZE - 1],
    ["bytes=10-19", 10, 19],
    ["bytes=500-", 500, SIZE - 1],
    ["bytes=-500", SIZE - 500, SIZE - 1],
    ["bytes=-99999999", 0, SIZE - 1],
  ];

  for (const [range, start, end] of partial) {
    it(`${range} serves ${start}-${end}`, async () => {
      const obj = await getObject({ bucket, key, range });
      assert.equal(obj.ContentRange, `bytes ${start}-${end}/${SIZE}`);
      assert.equal(obj.ContentLength, end - start + 1);
      const bytes = await read(obj.Body);
      assert.equal(bytes.length, end - start + 1);
      assert.ok(bytes.equals(data.subarray(start, end + 1)), "wrong bytes");
    });
  }

  for (const range of ["bytes=1048576-", "bytes=2000000-3000000", "bytes=-0"]) {
    it(`${range} is unsatisfiable`, async () => {
      await assert.rejects(getObject({ bucket, key, range }), (err: unknown) => {
        assert.ok(err instanceof RangeNotSatisfiableError);
        assert.equal(err.size, SIZE);
        return true;
      });
    });
  }

  for (const range of [undefined, "bytes=0-1,5-6", "bytes=abc", "bytes=9-3", "items=0-5"]) {
    it(`${String(range)} serves the whole file`, async () => {
      const obj = await getObject({ bucket, key, range });
      assert.equal(obj.ContentRange, undefined);
      assert.equal(obj.ContentLength, SIZE);
      assert.ok((await read(obj.Body)).equals(data));
    });
  }

  it("refuses a range of an empty file", async () => {
    await assert.rejects(getObject({ bucket, key: "uploads/empty.bin", range: "bytes=0-" }), RangeNotSatisfiableError);
  });
});
