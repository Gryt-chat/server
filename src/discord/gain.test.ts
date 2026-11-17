import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Gate, Leveller, levelFrame, loadCodec } from "./gain";

const tone = (amp: number) => new Float32Array(960).map((_, i) => amp * Math.sin(i / 8));
const rms = (pcm: Float32Array) => Math.sqrt(pcm.reduce((n, s) => n + s * s, 0) / pcm.length);

describe("levelFrame", () => {
  it("brings quiet speech up to the target", () => {
    const state: { gain: number; level?: number } = { gain: 1 };
    const out = tone(0.01);
    for (let i = 0; i < 100; i++) levelFrame(tone(0.01), state);
    assert.ok(levelFrame(out, state));
    assert.ok(Math.abs(rms(out) - 0.055) < 0.005, `rms ${rms(out)}`);
  });

  it("doesn't turn loud speech down below 1x or clip it", () => {
    const state: { gain: number; level?: number } = { gain: 1 };
    const out = tone(0.9);
    levelFrame(out, state);
    assert.equal(state.gain, 1);
    assert.ok(Math.max(...out) < 1);
  });

});

describe("Gate", () => {
  const p = (n: number) => Uint8Array.of(n);
  const run = (gate: Gate, loud: boolean[]) => loud.flatMap((l, i) => [...gate.push(p(i), l)].map((x) => x[0]));

  it("drops a lone click and a two-frame tap", () => {
    assert.deepEqual(run(new Gate(), [false, true, false, true, true, false, false]), []);
  });

  it("opens on the third loud frame and sends the held ones with it", () => {
    assert.deepEqual(run(new Gate(), [false, true, true, true, true]), [1, 2, 3, 4]);
  });

  it("keeps sending through a short pause, then stops", () => {
    const sent = run(new Gate(), [true, true, true, ...Array<boolean>(14).fill(false)]);
    assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("Leveller", () => {
  it("turns eight 2.5 ms packets into one louder 20 ms packet", async () => {
    const codec = await loadCodec();
    const enc = codec.encoder({ frame: 120, bitrate: 96000 });
    const level = new Leveller(codec);
    const out: Uint8Array[] = [];
    for (let k = 0; k < 400; k++) out.push(...level.push(enc.encode(tone(0.02).subarray((k % 8) * 120, (k % 8) * 120 + 120))));
    assert.equal(out.length, 50);
    const dec = codec.decoder(960);
    const loud = out.map((p) => dec.decode(p)).at(-1)!;
    assert.ok(rms(loud) > 0.03, `rms ${rms(loud)}`);
    level.destroy();
    enc.destroy();
  });
});
