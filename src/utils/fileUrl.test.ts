/**
 * The desktop and the phone sign these URLs themselves, so the bytes signed here
 * are a wire format. The same vector is in both clients' tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSignedFileUrl, generateFileUrlKey, readSignedFileUrl, signFileUrl } from "./fileUrl";

const FILE_ID = "0f8a3c52-6a8e-4b8e-9d0e-2f7c1b1e4a90";

test("the signature matches the vector the clients check against", () => {
  const key = Buffer.alloc(32, 7);
  assert.equal(signFileUrl(key, FILE_ID, false, 1790000100), "inQYY_jLD5cG4YmQa-Lj6x5PoUM07mxSLe3TYDBpUjY");
  assert.equal(signFileUrl(key, FILE_ID, true, 1790000100), "PsNKwED5XP3kVQzI8Hd9VLIVDSxRGXbQ1xy3yoJYvBg");
});

test("the key is bound to the host it was minted for", () => {
  const nowMs = 1_790_000_000_000;
  const payload = { grytUserId: "g", serverUserId: "u1", nickname: "n", serverHost: "a.example", tokenVersion: 0 };
  const fk = generateFileUrlKey(payload, nowMs);
  const expires = 1_790_000_300;
  const sig = signFileUrl(Buffer.from(fk.key, "base64url"), FILE_ID, false, expires);
  const signed = readSignedFileUrl({ u: fk.user, k: String(fk.until), e: String(expires), s: sig });
  assert.ok(signed);
  const check = { fileId: FILE_ID, thumb: false, tokenVersion: 0, userTokenVersion: 0, nowMs };
  assert.equal(checkSignedFileUrl(signed, { ...check, serverHost: "a.example" }), true);
  assert.equal(checkSignedFileUrl(signed, { ...check, serverHost: "b.example" }), false);
  assert.equal(checkSignedFileUrl(signed, { ...check, serverHost: "a.example", tokenVersion: 1 }), false);
});

test("malformed parameters read as no signature at all", () => {
  assert.equal(readSignedFileUrl({ t: "x" }), null);
  assert.equal(readSignedFileUrl({ u: "u", k: "1", e: "2", s: "short" }), null);
  assert.equal(readSignedFileUrl({ u: "u", k: "1e9", e: "2", s: "a".repeat(43) }), null);
  assert.equal(readSignedFileUrl({ u: ["u"], k: "1", e: "2", s: "a".repeat(43) }), null);
});
