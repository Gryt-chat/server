import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addressIsOwn, resolveClientIp, trustedProxyHops } from "./clientAddress";

describe("trustedProxyHops", () => {
  it("is zero unless set to a positive number", () => {
    for (const value of [undefined, "", "0", "-1", "not-a-number"]) {
      assert.equal(trustedProxyHops({ GRYT_TRUSTED_PROXY_HOPS: value }), 0);
    }
    assert.equal(trustedProxyHops({ GRYT_TRUSTED_PROXY_HOPS: "2" }), 2);
  });
});

describe("resolveClientIp", () => {
  it("ignores x-forwarded-for entirely when no hops are trusted", () => {
    assert.equal(
      resolveClientIp("203.0.113.10", "10.0.0.5, 192.168.1.1", 0),
      "203.0.113.10",
    );
  });

  it("reads the client's address behind one proxy", () => {
    // One proxy appends one entry: its peer, which is the client.
    assert.equal(resolveClientIp("172.17.0.1", "203.0.113.10", 1), "203.0.113.10");
  });

  it("counts hops from the right, so a client's own claim is never read", () => {
    // A client that sets the header gets its claim pushed leftwards by every
    // proxy that appends after it. Trusting one hop reads the rightmost entry.
    const chain = "1.1.1.1, 203.0.113.10, 172.17.0.1";
    assert.equal(resolveClientIp("10.0.0.1", chain, 1), "172.17.0.1");
    assert.equal(resolveClientIp("10.0.0.1", chain, 2), "203.0.113.10");
    assert.equal(resolveClientIp("10.0.0.1", chain, 3), "1.1.1.1");
  });

  it("falls back to the socket when the chain is shorter than the hop count", () => {
    assert.equal(resolveClientIp("172.17.0.1", "203.0.113.10", 3), "172.17.0.1");
  });
});

describe("addressIsOwn", () => {
  it("is true for a direct connection with no forwarded header", () => {
    assert.equal(addressIsOwn(undefined, 0), true);
    assert.equal(addressIsOwn("", 0), true);
  });

  // The case this exists for. A request that crossed a proxy leaves the socket
  // address pointing at the proxy, and proxies live on the same private ranges
  // that LAN open join accepts as proof of being on the local network.
  it("is false when a proxy appended to the chain and no hops are trusted", () => {
    assert.equal(addressIsOwn("203.0.113.10", 0), false);
    assert.equal(addressIsOwn(["203.0.113.10", "10.0.0.5"], 0), false);
  });

  it("is true once the operator has said how many proxies to believe", () => {
    assert.equal(addressIsOwn("203.0.113.10", 1), true);
  });

  // Setting the header on your own request only costs you a bypass you would
  // otherwise have been given. It cannot be used to gain one.
  it("cannot be used by a client to claim an address", () => {
    assert.equal(addressIsOwn("192.168.1.50", 0), false);
  });
});
