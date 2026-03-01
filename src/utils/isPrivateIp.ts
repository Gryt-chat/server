const IPV4_PRIVATE_RANGES = [
  { prefix: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { prefix: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { prefix: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
  { prefix: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8
  { prefix: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 (link-local)
];

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  return num >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const num = parseIPv4(ip);
  if (num === null) return false;
  return IPV4_PRIVATE_RANGES.some((r) => (num & r.mask) === r.prefix);
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80")) return true;   // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
}

export function isPrivateIp(raw: string): boolean {
  const ip = raw.trim();
  if (!ip || ip === "unknown") return false;

  // IPv4-mapped IPv6: "::ffff:192.168.1.1"
  const ffmpMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (ffmpMatch) return isPrivateIPv4(ffmpMatch[1]);

  if (ip.includes(":")) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}
