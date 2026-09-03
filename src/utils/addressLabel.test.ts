import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addressLabel } from "./addressLabel";

/**
 * The two properties that matter, and they pull in opposite directions: the
 * label has to be stable enough to tell one caller from another, and useless
 * enough that it is not the address.
 */
describe("labelling an address", () => {
  it("gives the same address the same label", () => {
    // Without this the log cannot say whether one caller is hammering it.
    assert.equal(addressLabel("203.0.113.7"), addressLabel("203.0.113.7"));
  });

  it("gives two addresses two labels", () => {
    assert.notEqual(addressLabel("203.0.113.7"), addressLabel("203.0.113.8"));
  });

  it("does not contain the address", () => {
    const label = addressLabel("203.0.113.7");
    assert.ok(!label.includes("203"));
    assert.ok(!label.includes("113"));
    assert.match(label, /^ip_[0-9a-f]{8}$/);
  });

  it("says so when there is no address", () => {
    // Rather than hashing "" or "unknown" into something that reads like a
    // caller. Several of these at once is a proxy to look at.
    assert.equal(addressLabel(undefined), "ip_unknown");
    assert.equal(addressLabel(null), "ip_unknown");
    assert.equal(addressLabel(""), "ip_unknown");
  });

  it("labels an IPv6 address too", () => {
    const label = addressLabel("2001:db8::1");
    assert.match(label, /^ip_[0-9a-f]{8}$/);
    assert.notEqual(label, addressLabel("2001:db8::2"));
  });
});
