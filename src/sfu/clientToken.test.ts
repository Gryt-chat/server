import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { signClientToken, mintClientToken, TOKEN_VERSION } from "./clientToken";

const SECRET = "shared-server-secret";

describe("signClientToken", () => {
  // Pinned on both sides. internal/auth/clienttoken_test.go in the SFU asserts
  // the same string, so if either implementation drifts a test fails here
  // instead of a call failing in production.
  it("matches the vector the SFU pins", () => {
    const token = signClientToken(SECRET, "user-abc", "room-xyz", 1788000000000, "nonce-1");
    assert.equal(
      token,
      "v1.dXNlci1hYmN8cm9vbS14eXp8MTc4ODAwMDAwMDAwMHxub25jZS0x.sRfyhPQhUzcu-oYapTqoxWvli-5pT1f1OTVl80vPE8c",
    );
  });

  it("signs the room and user rather than sending them alongside", () => {
    const a = signClientToken(SECRET, "user-abc", "room-one", 1788000000000, "n");
    const b = signClientToken(SECRET, "user-abc", "room-two", 1788000000000, "n");
    assert.notEqual(a, b, "a token for one room must not also be a token for another");
  });

  it("changes with the secret", () => {
    const a = signClientToken(SECRET, "u", "r", 1788000000000, "n");
    const b = signClientToken("a-different-secret", "u", "r", 1788000000000, "n");
    assert.notEqual(a, b);
  });

  it("is version-prefixed so the format can change later", () => {
    assert.ok(signClientToken(SECRET, "u", "r", 1, "n").startsWith(`${TOKEN_VERSION}.`));
  });
});

describe("mintClientToken", () => {
  it("uses a fresh nonce each time, so two tokens are never identical", () => {
    const now = 1788000000000;
    assert.notEqual(mintClientToken(SECRET, "u", "r", now), mintClientToken(SECRET, "u", "r", now));
  });

  it("expires, and puts the expiry inside the signed payload", () => {
    const now = 1788000000000;
    const payload = Buffer.from(mintClientToken(SECRET, "u", "r", now).split(".")[1], "base64url").toString("utf8");
    const expiry = Number(payload.split("|")[2]);
    assert.ok(expiry > now, "expiry must be in the future");
    assert.ok(expiry <= now + 10 * 60 * 1000, "expiry must not be far out");
  });
});
