import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  signClientToken,
  signClientTokenV2,
  mintClientToken,
  CAP_SPEAK,
  TOKEN_VERSION,
  TOKEN_VERSION_2,
} from "./clientToken";

const SECRET = "shared-server-secret";

describe("signClientToken", () => {
  // Pinned on both sides. internal/auth/clienttoken_test.go in the SFU asserts
  // the same string, so if either implementation drifts a test fails here
  // instead of a call failing in production.
  //
  // That was not true until GRYT-803 — this comment claimed it while the Go
  // side pinned nothing, so the agreement it describes was never actually
  // checked from the other end. It is now.
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
    assert.notEqual(
      mintClientToken(SECRET, "u", "r", [], now),
      mintClientToken(SECRET, "u", "r", [], now),
    );
  });

  it("expires, and puts the expiry inside the signed payload", () => {
    const now = 1788000000000;
    const payload = Buffer.from(
      mintClientToken(SECRET, "u", "r", [], now).split(".")[1],
      "base64url",
    ).toString("utf8");
    const expiry = Number(payload.split("|")[2]);
    assert.ok(expiry > now, "expiry must be in the future");
    assert.ok(expiry <= now + 10 * 60 * 1000, "expiry must not be far out");
  });
});

describe("signClientTokenV2", () => {
  // The other half of the pinned pair above. The SFU verifies what this signs,
  // so a capability list that serialises differently on the two sides is a
  // member who cannot speak and no error anywhere saying why.
  it("matches the vector the SFU pins", () => {
    assert.equal(
      signClientTokenV2(SECRET, "user-abc", "room-xyz", 1788000000000, "nonce-1", [CAP_SPEAK]),
      "v2.dXNlci1hYmN8cm9vbS14eXp8MTc4ODAwMDAwMDAwMHxub25jZS0xfHNwZWFr.Sl_XerGqvdjvr6PFkUIBTtaf_zBFWetug06e8elPPzk",
    );
  });

  // The shape a denied member actually gets, and the one with a trailing
  // separator that is easy to drop on one side and not the other.
  it("matches the SFU's vector for no capabilities at all", () => {
    assert.equal(
      signClientTokenV2(SECRET, "user-abc", "room-xyz", 1788000000000, "nonce-1", []),
      "v2.dXNlci1hYmN8cm9vbS14eXp8MTc4ODAwMDAwMDAwMHxub25jZS0xfA.caTW8CLQDzyjZJbUzMtPb_OAsKzfH6lPOO2G9kBEeWE",
    );
  });

  it("signs the capabilities rather than sending them alongside", () => {
    const withSpeak = signClientTokenV2(SECRET, "u", "r", 1788000000000, "n", [CAP_SPEAK]);
    const without = signClientTokenV2(SECRET, "u", "r", 1788000000000, "n", []);
    assert.notEqual(withSpeak, without, "a token granting speak must differ from one that does not");

    // And the signature has to be what differs, not only the payload — a client
    // that swaps the payload in keeps a signature that no longer matches.
    assert.notEqual(withSpeak.split(".")[2], without.split(".")[2]);
  });

  it("is prefixed v2, so the SFU knows to read a capability field", () => {
    assert.ok(signClientTokenV2(SECRET, "u", "r", 1, "n", []).startsWith(`${TOKEN_VERSION_2}.`));
    assert.notEqual(TOKEN_VERSION_2, TOKEN_VERSION);
  });
});

describe("mintClientToken", () => {
  it("mints v2 now, so the capability list is carried at all", () => {
    assert.ok(mintClientToken(SECRET, "u", "r", [CAP_SPEAK]).startsWith(`${TOKEN_VERSION_2}.`));
  });

  it("puts the capabilities in the payload", () => {
    const payload = Buffer.from(
      mintClientToken(SECRET, "u", "r", [CAP_SPEAK]).split(".")[1],
      "base64url",
    ).toString("utf8");
    assert.equal(payload.split("|")[4], CAP_SPEAK);
  });

  it("carries an empty field when nothing is granted", () => {
    const payload = Buffer.from(
      mintClientToken(SECRET, "u", "r", []).split(".")[1],
      "base64url",
    ).toString("utf8");
    assert.equal(payload.split("|").length, 5, "the capability field must be present even when empty");
    assert.equal(payload.split("|")[4], "");
  });
});

describe("an empty secret", () => {
  // GRYT-786. SERVER_PASSWORD defaulted to empty and this was the only thing
  // that read it, so the signing key on an ordinary deployment was a value
  // anybody can guess. HMAC accepts an empty key perfectly happily, which is
  // why the refusal has to be written down rather than relied upon.
  it("is refused, because HMAC would accept it", () => {
    assert.throws(() => mintClientToken("", "u", "r", [CAP_SPEAK]), /empty secret/);
  });

  it("does not stop a real secret working", () => {
    assert.ok(mintClientToken(SECRET, "u", "r", [CAP_SPEAK]).startsWith(`${TOKEN_VERSION_2}.`));
  });
});
