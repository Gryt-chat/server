import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Regroup, frameSamples, joinFrames } from "./opusFrames";

// Config 16 is CELT fullband 2.5 ms; 19 is CELT 20 ms; 15 is hybrid 20 ms.
const celt2_5 = (n: number, len = 10) => Uint8Array.from([16 << 3, ...Array.from({ length: len }, (_, i) => (n + i) & 0xff)]);

describe("Opus regrouping for Discord", () => {
  it("knows how long a frame is from its config", () => {
    assert.equal(frameSamples(16 << 3), 120);
    assert.equal(frameSamples(19 << 3), 960);
    assert.equal(frameSamples(15 << 3), 960);
    assert.equal(frameSamples(1 << 3), 960);
  });

  it("joins eight 2.5 ms frames into one 20 ms code-3 packet", () => {
    const r = new Regroup();
    const out = [];
    for (let i = 0; i < 8; i++) out.push(...r.push(celt2_5(i)));
    assert.equal(out.length, 1);
    const p = out[0];
    assert.equal(p[0], (16 << 3) | 3);
    assert.equal(p[1], 0x80 | 8);
    assert.deepEqual([...p.subarray(2, 9)], [10, 10, 10, 10, 10, 10, 10]);
    assert.equal(p.length, 2 + 7 + 80);
  });

  it("passes a 20 ms packet through as it is", () => {
    const r = new Regroup();
    const packet = Uint8Array.from([19 << 3, 1, 2, 3]);
    assert.deepEqual(r.push(packet), [packet]);
  });

  it("writes a frame length of 252 or more in two bytes", () => {
    const p = joinFrames(16 << 3, [new Uint8Array(300), new Uint8Array(5)]);
    assert.deepEqual([...p.subarray(2, 4)], [252 + (300 & 3), (300 - 252 - (300 & 3)) >> 2]);
  });

  it("starts over when the config changes partway", () => {
    const r = new Regroup();
    for (let i = 0; i < 4; i++) r.push(celt2_5(i));
    assert.equal(r.push(Uint8Array.from([19 << 3, 9])).length, 1);
  });
});
