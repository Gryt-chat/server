import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveScheme } from "./requestScheme";

describe("resolveScheme", () => {
  it("believes only the socket when no hops are trusted", () => {
    assert.equal(resolveScheme(false, "https", 0), "http");
    assert.equal(resolveScheme(true, "http", 0), "https");
  });

  it("reads the proxy's header behind one hop", () => {
    assert.equal(resolveScheme(false, "https", 1), "https");
    assert.equal(resolveScheme(false, "HTTPS", 1), "https");
    assert.equal(resolveScheme(true, "http", 1), "http");
  });

  it("counts from the right, so a client's own claim on the left is never read", () => {
    assert.equal(resolveScheme(false, "https, http", 1), "http");
    assert.equal(resolveScheme(false, "http, https", 1), "https");
    assert.equal(resolveScheme(false, "http, https, http", 2), "https");
    assert.equal(resolveScheme(false, ["http", "https"], 1), "https");
  });

  it("reads a single value however many hops are trusted", () => {
    assert.equal(resolveScheme(false, "https", 2), "https");
  });

  it("keeps the socket's scheme for a missing or unknown value", () => {
    assert.equal(resolveScheme(false, undefined, 1), "http");
    assert.equal(resolveScheme(false, "", 1), "http");
    assert.equal(resolveScheme(false, "ftp", 1), "http");
    assert.equal(resolveScheme(true, "javascript", 1), "https");
  });
});
