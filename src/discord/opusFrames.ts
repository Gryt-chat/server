/** Opus frame length in 48 kHz samples, by the TOC byte's config (RFC 6716 §3.1). */
export function frameSamples(toc: number): number {
  const config = toc >> 3;
  if (config < 12) return [480, 960, 1920, 2880][config % 4];
  if (config < 16) return [480, 960][config % 2];
  return [120, 240, 480, 960][config % 4];
}

/** The frames in one packet, or null for a shape this doesn't split (RFC 6716 §3.2). */
export function framesOf(packet: Uint8Array): { toc: number; frames: Uint8Array[] } | null {
  if (packet.length < 1) return null;
  const toc = packet[0];
  const body = packet.subarray(1);
  switch (toc & 3) {
    case 0:
      return { toc, frames: [body] };
    case 1: {
      if (body.length % 2) return null;
      const half = body.length / 2;
      return { toc, frames: [body.subarray(0, half), body.subarray(half)] };
    }
    default:
      return null;
  }
}

function lengthBytes(n: number): number[] {
  return n < 252 ? [n] : [252 + (n & 3), (n - 252 - (n & 3)) >> 2];
}

/** Several frames with the same config as one code-3 packet: VBR, no padding (RFC 6716 §3.2.5). */
export function joinFrames(toc: number, frames: Uint8Array[]): Uint8Array {
  if (frames.length === 1) return Uint8Array.from([toc & 0xfc, ...frames[0]]);
  const head = [(toc & 0xfc) | 3, 0x80 | frames.length];
  for (const f of frames.slice(0, -1)) head.push(...lengthBytes(f.length));
  const out = new Uint8Array(head.length + frames.reduce((n, f) => n + f.length, 0));
  out.set(head, 0);
  let at = head.length;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Collects one speaker's short frames into the 20 ms packets Discord plays. A change of config flushes what was gathered. */
export class Regroup {
  private toc = -1;
  private frames: Uint8Array[] = [];
  private samples = 0;

  push(packet: Uint8Array): Uint8Array[] {
    const parsed = framesOf(packet);
    if (!parsed) return [];
    const out: Uint8Array[] = [];
    const per = frameSamples(parsed.toc);
    if ((parsed.toc & 0xfc) !== (this.toc & 0xfc)) {
      this.frames = [];
      this.samples = 0;
      this.toc = parsed.toc;
    }
    for (const f of parsed.frames) {
      this.frames.push(f);
      this.samples += per;
      if (this.samples >= 960) {
        out.push(joinFrames(this.toc, this.frames));
        this.frames = [];
        this.samples = 0;
      }
    }
    return out;
  }

  reset(): void {
    this.toc = -1;
    this.frames = [];
    this.samples = 0;
  }
}
