import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

import { RangeNotSatisfiableError } from "../utils/byteRange";
import { getObject, getS3, initS3 } from "./s3";

/** No MinIO in CI, so `send` is stubbed with what MinIO answered when probed:
    it clamps the end itself and throws InvalidRange for a start past the end. */

const SIZE = 1000;
type Sent = { name: string; range?: string };

function invalidRange(): Error {
  const err = new Error("The requested range is not satisfiable");
  err.name = "InvalidRange";
  return err;
}

describe("s3 getObject with a Range", () => {
  let sent: Sent[] = [];

  before(() => {
    initS3();
    const client = getS3() as unknown as { send: (cmd: unknown) => Promise<unknown> };
    client.send = async (cmd: unknown) => {
      if (cmd instanceof HeadObjectCommand) {
        sent.push({ name: "head" });
        return { ContentLength: SIZE };
      }
      assert.ok(cmd instanceof GetObjectCommand);
      const range = cmd.input.Range;
      sent.push({ name: "get", range });
      if (range === "bytes=5000-" || range === "bytes=-0") throw invalidRange();
      return { ContentLength: SIZE };
    };
  });

  it("passes a single range through for S3 to clamp", async () => {
    for (const range of ["bytes=0-99999999", "bytes=-500", "bytes=500-"]) {
      sent = [];
      await getObject({ bucket: "b", key: "k", range });
      assert.deepEqual(sent, [{ name: "get", range }]);
    }
  });

  it("drops a header the filesystem backend would ignore", async () => {
    // MinIO answers 416 to `bytes=9-3`, where the filesystem serves the file.
    for (const range of ["bytes=0-1,5-6", "bytes=abc", "bytes=9-3", "items=0-5"]) {
      sent = [];
      await getObject({ bucket: "b", key: "k", range });
      assert.deepEqual(sent, [{ name: "get", range: undefined }], range);
    }
  });

  it("turns InvalidRange into RangeNotSatisfiableError with the object size", async () => {
    for (const range of ["bytes=5000-", "bytes=-0"]) {
      sent = [];
      await assert.rejects(getObject({ bucket: "b", key: "k", range }), (err: unknown) => {
        assert.ok(err instanceof RangeNotSatisfiableError);
        assert.equal(err.size, SIZE);
        return true;
      });
      assert.deepEqual(sent, [{ name: "get", range }, { name: "head" }]);
    }
  });
});
