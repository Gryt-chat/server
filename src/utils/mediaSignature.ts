import { open } from "node:fs/promises";

export function mediaMimeFromHeader(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) return "image/tiff";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = bytes.subarray(8, 32).toString("ascii");
    if (/avif|avis/.test(brands)) return "image/avif";
    if (/heic|heix|hevc|hevx|mif1|msf1/.test(brands)) return "image/heif";
    return "video/mp4";
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return "video/webm";
  return null;
}

export async function mediaMimeFromFile(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return mediaMimeFromHeader(header.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}
