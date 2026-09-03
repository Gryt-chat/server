/**
 * The two tokens must not be interchangeable.
 *
 * They are signed with the same secret, so nothing but the scope claim keeps
 * them apart — and the whole point of the file token is that it is the weaker
 * of the two. If it verified as an access token, putting it in a URL would be
 * putting the session in a URL, which is what GRYT-740 set out to stop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generateAccessToken,
  generateFileToken,
  verifyAccessToken,
  verifyFileToken,
  type TokenPayload,
} from "./jwt";

const payload: TokenPayload = {
  grytUserId: "gryt_abc",
  serverUserId: "user_abc",
  nickname: "Sivert",
  serverHost: "demo.gryt.chat",
  tokenVersion: 3,
};

test("a file token verifies and carries what the route checks", () => {
  const decoded = verifyFileToken(generateFileToken(payload));
  assert.ok(decoded);
  assert.equal(decoded.scope, "file");
  assert.equal(decoded.serverUserId, "user_abc");
  assert.equal(decoded.serverHost, "demo.gryt.chat");
  assert.equal(decoded.tokenVersion, 3);
});

test("an access token is not a file token", () => {
  assert.equal(verifyFileToken(generateAccessToken(payload)), null);
});

test("a file token is not an access token", () => {
  // The direction that matters. This one ends up in query strings.
  assert.equal(verifyAccessToken(generateFileToken(payload)), null);
});

test("an access token still verifies as itself", () => {
  const decoded = verifyAccessToken(generateAccessToken(payload));
  assert.ok(decoded);
  assert.equal(decoded.serverUserId, "user_abc");
});

test("rubbish verifies as neither", () => {
  for (const junk of ["", "not-a-token", "a.b.c"]) {
    assert.equal(verifyFileToken(junk), null);
    assert.equal(verifyAccessToken(junk), null);
  }
});
