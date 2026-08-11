import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { memberIdentity } from "./memberIdentity";

const ACCOUNT_SUB = "0c8f2e1a-4b6d-4f2a-9c3e-71b0a5d9e4f7";
const LOCAL_SUB = "key:eZ47ZhVKu6_e6Glm9igRkZUfT5kuMgM6pBvqckPkXoQ";

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("member identity", () => {
  it("reads the tier off the id alone", () => {
    assert.equal(memberIdentity(ACCOUNT_SUB).identityTier, "account");
    assert.equal(memberIdentity(LOCAL_SUB).identityTier, "local");
  });

  it("never returns the id it was given", () => {
    process.env.JWT_SECRET = "secret-a";
    for (const sub of [ACCOUNT_SUB, LOCAL_SUB]) {
      const { identityFingerprint } = memberIdentity(sub);
      assert.ok(!identityFingerprint.includes(sub));
      assert.ok(!sub.includes(identityFingerprint));
    }
  });

  it("is stable for the same id on the same server", () => {
    process.env.JWT_SECRET = "secret-a";
    assert.equal(
      memberIdentity(ACCOUNT_SUB).identityFingerprint,
      memberIdentity(ACCOUNT_SUB).identityFingerprint,
    );
  });

  it("differs between servers for the same account", () => {
    // The privacy property. One Keycloak sub is the same id on every Gryt
    // server, so two member lists must not carry the same marker for it.
    process.env.JWT_SECRET = "secret-a";
    const a = memberIdentity(ACCOUNT_SUB).identityFingerprint;
    process.env.JWT_SECRET = "secret-b";
    const b = memberIdentity(ACCOUNT_SUB).identityFingerprint;
    assert.notEqual(a, b);
  });

  it("differs between identities on the same server", () => {
    process.env.JWT_SECRET = "secret-a";
    assert.notEqual(
      memberIdentity(ACCOUNT_SUB).identityFingerprint,
      memberIdentity(LOCAL_SUB).identityFingerprint,
    );
  });

  it("is long enough that matching one means finding a collision", () => {
    // The anti-impersonation property rests on this. A truncated fingerprint
    // would be grindable by anyone who can mint keypairs, which is anybody
    // using a local identity.
    process.env.JWT_SECRET = "secret-a";
    const { identityFingerprint } = memberIdentity(LOCAL_SUB);
    assert.equal(identityFingerprint.length, 43); // 256 bits, base64url
  });
});
