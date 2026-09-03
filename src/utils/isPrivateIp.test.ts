import assert from "node:assert/strict";
import { test } from "node:test";

import { isPrivateIp } from "./isPrivateIp";

test("recognises every private IPv4 range, not only the low ones", () => {
  // 10/8 and 127/8 always worked. The other three did not: `num & mask` is a
  // signed 32-bit value and their prefixes are unsigned literals, so the
  // comparison never came out true. That made `lan_open` refuse a client on a
  // 192.168 address, which is the address nearly every home LAN hands out.
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
});

test("leaves the addresses next door alone", () => {
  assert.equal(isPrivateIp("172.15.255.255"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
  assert.equal(isPrivateIp("192.169.0.1"), false);
  assert.equal(isPrivateIp("11.0.0.1"), false);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
});

test("handles IPv6 loopback, link-local and unique-local", () => {
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
});

test("reads an IPv4-mapped IPv6 address as the IPv4 it carries", () => {
  assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("says no to nonsense rather than throwing", () => {
  assert.equal(isPrivateIp(""), false);
  assert.equal(isPrivateIp("   "), false);
  assert.equal(isPrivateIp("unknown"), false);
  assert.equal(isPrivateIp("999.999.999.999"), false);
  assert.equal(isPrivateIp("10.0.0"), false);
  assert.equal(isPrivateIp("not-an-ip"), false);
});
