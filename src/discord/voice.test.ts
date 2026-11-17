import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Floor, nextTimestamp, voicePacket } from "./voice";

describe("Discord voice into Gryt", () => {
  it("wraps an Opus frame the way @gryt/voice reads it", () => {
    const p = voicePacket(0x1_0005, 0x1_0000_0003, new Uint8Array([0xfc, 1, 2]));
    const view = new DataView(p.buffer);
    assert.equal(view.getUint8(0), 1);
    assert.equal(view.getUint8(1), 1);
    assert.equal(view.getUint16(2), 5);
    assert.equal(view.getUint32(4), 3);
    assert.deepEqual([...p.subarray(8)], [0xfc, 1, 2]);
  });

  it("moves the timestamp one frame per packet, and by real time across a pause", () => {
    assert.equal(nextTimestamp(960, 1000, 1020), 1920);
    assert.equal(nextTimestamp(960, 1000, 1001), 1920);
    assert.equal(nextTimestamp(960, 1000, 3000), 960 + 100 * 960);
    assert.equal(nextTimestamp(0xffff_ffff, 0, 20), 959);
  });

  it("gives Discord one Gryt speaker at a time, until they've been quiet a moment", () => {
    const f = new Floor();
    assert.deepEqual(f.take("a", 0), { play: true, changed: true });
    assert.deepEqual(f.take("b", 100), { play: false, changed: false });
    assert.deepEqual(f.take("a", 200), { play: true, changed: false });
    assert.deepEqual(f.take("b", 500), { play: false, changed: false });
    assert.deepEqual(f.take("b", 700), { play: true, changed: true });
  });
});
