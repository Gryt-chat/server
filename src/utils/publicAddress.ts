import { isIP } from "node:net";

/** Network and prefix length, for outbound fetches only. `isPrivateIp` also decides LAN joins,
    so widening that one would change who counts as local. */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, where cloud metadata answers
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255
];

function ipv4Number(ip: string): number {
  return ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

const IPV4_RANGES = BLOCKED_IPV4.map(([network, bits]) => {
  const first = ipv4Number(network);
  return { first, last: first + 2 ** (32 - bits) - 1 };
});

function isPublicIPv4(ip: string): boolean {
  const n = ipv4Number(ip);
  return !IPV4_RANGES.some((range) => n >= range.first && n <= range.last);
}

/** The eight groups of an address `isIP` has already accepted. */
function ipv6Groups(ip: string): number[] {
  let text = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const parse = (part: string | undefined) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const [head, tail] = text.split("::");
  const front = parse(head);
  if (tail === undefined) return front;
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/** v4-mapped, v4-compatible, NAT64 and 6to4 all reach an IPv4 address, so that address decides. */
function embeddedIPv4(g: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

/** Global unicast is 2000::/3, which leaves out loopback, unique-local, link-local and multicast. */
function isPublicIPv6(g: number[]): boolean {
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23, Teredo included
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // documentation
  return true;
}

/** Anything that is not a well-formed address counts as not public. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIPv4(ip);
  if (family !== 6 || ip.includes("%")) return false;
  const groups = ipv6Groups(ip);
  const v4 = embeddedIPv4(groups);
  return v4 === null ? isPublicIPv6(groups) : isPublicIPv4(v4);
}
