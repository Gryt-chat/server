import { readFile } from "node:fs/promises";

import type { OpusCodec, OpusDecoder, OpusEncoder } from "@gryt/voice/codec";

const FRAME = 960;
/** Speech is brought to about -25 dBFS RMS, which measured the same as Discord's own processing (-24 LUFS). */
const TARGET_RMS = 0.055;
/** Under this a 20 ms frame is quiet. The gate opens after OPEN_AFTER loud frames, so a lone key click isn't sent, and closes after HANG quiet ones. */
const GATE_RMS = 0.003;
const OPEN_AFTER = 3;
const HANG = 10;

let codec: Promise<OpusCodec> | null = null;

export function loadCodec(): Promise<OpusCodec> {
  codec ??= import("@gryt/voice/codec").then(async ({ loadOpus }) => loadOpus(await readFile(require.resolve("@gryt/voice/codec/opus.wasm"))));
  return codec;
}

/** Scales one frame in place toward TARGET_RMS. Returns whether it's loud enough to count as sound. */
export function levelFrame(pcm: Float32Array, state: { gain: number; level?: number }): boolean {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  const rms = Math.sqrt(sum / pcm.length);
  const loud = rms >= GATE_RMS;
  if (loud) {
    // Follows the speaker's average level, not each syllable, so loud syllables don't drag the whole voice down.
    // Starts at TARGET_RMS (1x), so the first syllable isn't blasted before the level is known.
    state.level = (state.level ?? TARGET_RMS) + (rms - (state.level ?? TARGET_RMS)) * 0.1;
    // Never cuts, and the gate caps the boost at TARGET_RMS / GATE_RMS, about 18x.
    state.gain = Math.max(1, TARGET_RMS / state.level);
  }
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.tanh(pcm[i] * state.gain);
  return loud;
}

/** Sends while open; when closed, holds the last few packets so a word's first syllable goes out with it. */
export class Gate {
  private open = false;
  private run = 0;
  private quiet = 0;
  private held: Uint8Array[] = [];

  push(packet: Uint8Array, loud: boolean): Uint8Array[] {
    this.run = loud ? this.run + 1 : 0;
    if (this.open) {
      this.quiet = loud ? 0 : this.quiet + 1;
      if (this.quiet <= HANG) return [packet];
      this.open = false;
    }
    this.held = [...this.held, packet].slice(-OPEN_AFTER);
    if (this.run < OPEN_AFTER) return [];
    this.open = true;
    this.quiet = 0;
    const out = this.held;
    this.held = [];
    return out;
  }
}

/** Gryt's engines decode 2.5 ms frames only, so Discord's 20 ms packets are decoded and sent on as these (GRYT-2427). */
export const GRYT_FRAME = 120;
/** What a Gryt member sends by default (@gryt/voice native/core/engine.h). */
const GRYT_BITRATE = 192000;

/** One Discord speaker's packets in, Gryt's 2.5 ms packets out. Throws on a packet that doesn't decode. */
export class Reframer {
  private readonly decoder: OpusDecoder;
  private readonly encoder: OpusEncoder;

  constructor(opus: OpusCodec) {
    this.decoder = opus.decoder(FRAME);
    this.encoder = opus.encoder({ frame: GRYT_FRAME, bitrate: GRYT_BITRATE });
  }

  push(packet: Uint8Array): Uint8Array[] {
    const pcm = this.decoder.decode(packet);
    const out: Uint8Array[] = [];
    for (let at = 0; at + GRYT_FRAME <= pcm.length; at += GRYT_FRAME) out.push(this.encoder.encode(pcm.subarray(at, at + GRYT_FRAME)));
    return out;
  }

  destroy(): void {
    this.decoder.destroy();
    this.encoder.destroy();
  }
}

/** One speaker's packets in, louder 20 ms packets out, nothing during silence. */
export class Leveller {
  private decoder: OpusDecoder;
  private readonly encoder: OpusEncoder;
  private readonly buf = new Float32Array(FRAME);
  private filled = 0;
  private state: { gain: number; level?: number } = { gain: 1 };
  private gate = new Gate();

  constructor(private readonly opus: OpusCodec) {
    this.decoder = opus.decoder(FRAME);
    this.encoder = opus.encoder({ frame: FRAME, bitrate: 64000 });
  }

  push(packet: Uint8Array): Uint8Array[] {
    const pcm = this.decoder.decode(packet);
    const out: Uint8Array[] = [];
    for (let at = 0; at < pcm.length; ) {
      const n = Math.min(FRAME - this.filled, pcm.length - at);
      this.buf.set(pcm.subarray(at, at + n), this.filled);
      this.filled += n;
      at += n;
      if (this.filled < FRAME) continue;
      this.filled = 0;
      // Encoded even when gated, so the encoder never jumps across a gap.
      const loud = levelFrame(this.buf, this.state);
      out.push(...this.gate.push(this.encoder.encode(this.buf), loud));
    }
    return out;
  }

  /** A new speaker: their decoder state and level start fresh. */
  reset(): void {
    this.decoder.destroy();
    this.decoder = this.opus.decoder(FRAME);
    this.filled = 0;
    this.state = { gain: 1 };
    this.gate = new Gate();
  }

  destroy(): void {
    this.decoder.destroy();
    this.encoder.destroy();
  }
}
