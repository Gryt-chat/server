import assert from "node:assert/strict";
import { test } from "node:test";

import { isPublicAddress } from "./publicAddress";

function refuses(...addresses: string[]) {
  for (const address of addresses) assert.equal(isPublicAddress(address), false, address);
}

function allows(...addresses: string[]) {
  for (const address of addresses) assert.equal(isPublicAddress(address), true, address);
}

test("refuses loopback, private, link-local and the metadata address", () => {
  refuses("127.0.0.1", "127.255.255.255", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1");
  refuses("169.254.169.254", "169.254.0.1");
});

test("refuses CGNAT, 0.0.0.0/8, multicast, broadcast and the documentation ranges", () => {
  // 100.100.100.200 is Alibaba Cloud's metadata service, inside CGNAT.
  refuses("100.64.0.1", "100.100.100.200", "100.127.255.255");
  refuses("0.0.0.0", "0.0.0.1", "0.255.255.255");
  refuses("224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255");
  refuses("192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1");
});

test("allows the public addresses right next to a refused range", () => {
  allows("8.8.8.8", "1.1.1.1", "93.184.215.14");
  allows("100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.1", "192.169.0.1", "223.255.255.255");
  allows("1.0.0.0", "126.255.255.255", "128.0.0.0", "198.17.255.255", "198.20.0.0");
});

test("refuses IPv6 loopback, unspecified, unique-local, link-local and multicast", () => {
  refuses("::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1");
  refuses("0:0:0:0:0:0:0:1");
});

test("refuses a v4-mapped address in either spelling when the IPv4 inside is private", () => {
  // WHATWG URL turns [::ffff:127.0.0.1] into [::ffff:7f00:1], which isPrivateIp did not read.
  refuses("::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::FFFF:C0A8:0101");
  refuses("0:0:0:0:0:ffff:7f00:1", "::127.0.0.1", "::7f00:1");
  allows("::ffff:8.8.8.8", "::ffff:808:808");
});

test("reads the IPv4 address inside NAT64 and 6to4 rather than refusing the prefix", () => {
  refuses("64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::", "2002:a9fe:a9fe::1");
  allows("64:ff9b::808:808", "2002:808:808::1");
  // The local-use NAT64 prefix can point anywhere, so it is refused whole.
  refuses("64:ff9b:1::808:808");
});

test("allows global unicast, except Teredo and documentation", () => {
  allows("2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e");
  refuses("2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "3fff::1");
});

test("refuses things that are not addresses at all", () => {
  refuses("", "localhost", "example.com", "999.1.1.1", "10.0.0", "fe80::1%lo0", "[::1]", "1.2.3.4.5");
});
