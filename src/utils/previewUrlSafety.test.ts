import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPreviewUrl, isBlockedPreviewHost } from "./previewUrlSafety";

test("blocks the loopback by name and by address", () => {
  assert.equal(isBlockedPreviewHost("localhost"), true);
  assert.equal(isBlockedPreviewHost("LOCALHOST"), true);
  assert.equal(isBlockedPreviewHost("127.0.0.1"), true);
  assert.equal(isBlockedPreviewHost("127.1.2.3"), true);
  assert.equal(isBlockedPreviewHost("[::1]"), true);
});

test("blocks the private ranges, including the ones the old regex missed", () => {
  assert.equal(isBlockedPreviewHost("10.0.0.1"), true);
  assert.equal(isBlockedPreviewHost("192.168.1.1"), true);
  assert.equal(isBlockedPreviewHost("172.16.0.1"), true);
  assert.equal(isBlockedPreviewHost("172.31.255.255"), true);
  // The previous check was /^(127|10|192\.168)\.\d/, which let both of these
  // through: link-local carries the cloud metadata service.
  assert.equal(isBlockedPreviewHost("169.254.169.254"), true);
  assert.equal(isBlockedPreviewHost("[fd00::1]"), true);
});

test("lets a public address through", () => {
  assert.equal(isBlockedPreviewHost("172.32.0.1"), false);
  assert.equal(isBlockedPreviewHost("8.8.8.8"), false);
  assert.equal(isBlockedPreviewHost("example.com"), false);
  assert.equal(isBlockedPreviewHost("[2606:4700::1111]"), false);
});

test("blocks the reserved suffixes and the metadata names", () => {
  assert.equal(isBlockedPreviewHost("anything.localhost"), true);
  assert.equal(isBlockedPreviewHost("db.internal"), true);
  assert.equal(isBlockedPreviewHost("metadata.google.internal"), true);
});

test("refuses a scheme that is not http", async () => {
  for (const url of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/"]) {
    const result = await checkPreviewUrl(url);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_url");
  }
});

test("refuses nonsense before it reaches DNS", async () => {
  const result = await checkPreviewUrl("not a url at all");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_url");
});

test("refuses a private literal without asking DNS about it", async () => {
  const result = await checkPreviewUrl("http://169.254.169.254/latest/meta-data/");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "blocked_host");
});

test("refuses a name that will not resolve", async () => {
  const result = await checkPreviewUrl("https://this-host-does-not-exist.invalid/x");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "blocked_host");
});
