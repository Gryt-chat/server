import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { leftoverS3Settings, uploadsDisabled } from "./index";

const KEYS = ["STORAGE_BACKEND", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "DISABLE_UPLOADS", "DISABLE_S3"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("storage is on disk only", () => {
  it("has nothing to complain about with no settings, or only a bucket name", () => {
    for (const k of KEYS) delete process.env[k];
    assert.deepEqual(leftoverS3Settings(), []);
    process.env.S3_BUCKET = "gryt";
    process.env.STORAGE_BACKEND = "filesystem";
    assert.deepEqual(leftoverS3Settings(), []);
  });

  it("names what's left of an S3 setup, so the server can refuse to start", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.STORAGE_BACKEND = "s3";
    process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
    assert.deepEqual(leftoverS3Settings(), ["STORAGE_BACKEND=s3", "S3_ENDPOINT"]);
  });

  it("takes uploads off under the new name and the old one", () => {
    for (const k of KEYS) delete process.env[k];
    assert.equal(uploadsDisabled(), false);
    process.env.DISABLE_UPLOADS = "true";
    assert.equal(uploadsDisabled(), true);
    delete process.env.DISABLE_UPLOADS;
    process.env.DISABLE_S3 = "TRUE";
    assert.equal(uploadsDisabled(), true);
  });
});
