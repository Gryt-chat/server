import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { storageBackendName } from "./index";

const KEYS = ["STORAGE_BACKEND", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const clear = () => KEYS.forEach((k) => delete process.env[k]);

describe("storage backend choice", () => {
  it("stores on disk when nothing is configured, instead of refusing every upload", () => {
    clear();
    assert.equal(storageBackendName(), "filesystem");
  });

  it("uses S3 once any S3 setting is given", () => {
    clear();
    process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
    assert.equal(storageBackendName(), "s3");
  });

  it("does what STORAGE_BACKEND says, either way", () => {
    clear();
    process.env.STORAGE_BACKEND = "s3";
    assert.equal(storageBackendName(), "s3");
    process.env.STORAGE_BACKEND = "Filesystem";
    process.env.S3_BUCKET = "gryt";
    assert.equal(storageBackendName(), "filesystem");
  });
});
