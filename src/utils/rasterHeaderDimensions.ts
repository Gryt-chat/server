import { mediaMimeFromHeader } from "./mediaSignature";

// Layout hints only. A readable header does not validate or approve a file.
export function rasterHeaderDimensions(bytes: Buffer): { width: number; height: number } | null {
  const dimensions = (width: number, height: number) =>
    width > 0 && height > 0 && width * height <= 100_000_000 ? { width, height } : null;
  const mime = mediaMimeFromHeader(bytes.subarray(0, 32));
  if (mime === "image/png" && bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (mime === "image/gif" && bytes.length >= 10) return dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return null;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || marker === 0x00) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return length >= 8 ? dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)) : null;
      }
      offset += length;
    }
  }
  if (mime === "image/webp") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (kind === "VP8X" && length >= 10 && start + 10 <= bytes.length) {
        return dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
      }
      if (kind === "VP8L" && length >= 5 && start + 5 <= bytes.length && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (kind === "VP8 " && length >= 10 && start + 10 <= bytes.length && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
        return dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
      }
      if (start + length > bytes.length) return null;
      offset = start + length + (length % 2);
    }
  }
  return null;
}
