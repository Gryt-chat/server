/* A remote picture's size from its header, for laying out a link preview. Never a decode: the
   bytes are a stranger's, and this runs in the server. Unknown formats answer null. */

export function imageHeaderSize(b: Buffer): { width: number; height: number } | null {
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w <= 65535 && h <= 65535 ? { width: w, height: h } : null);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR") {
    return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (b.length >= 10 && b.toString("latin1", 0, 4) === "GIF8") return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the markers to the first start-of-frame, which holds the size.
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      const length = b.readUInt16BE(at + 2);
      if (length < 2) return null;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return ok(b.readUInt16BE(at + 7), b.readUInt16BE(at + 5));
      at += 2 + length;
    }
  }
  return null;
}
