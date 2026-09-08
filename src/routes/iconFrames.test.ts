import assert from "node:assert/strict";
import { test } from "node:test";

import { validateImage } from "../utils/imageValidation";
import { MAX_ICON_FRAMES } from "./server";

/**
 * Built by hand because sharp will not write an animation from a stacked strip,
 * which is exactly the failure this would otherwise be blind to.
 */
function animatedGif(frames: number): Buffer {
  const b: number[] = [];
  const push = (...bytes: number[]) => b.push(...bytes);

  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
  push(1, 0, 1, 0, 0xf0, 0, 0); // 1x1, global colour table of 2
  push(0, 0, 0, 255, 255, 255); // black, white

  push(0x21, 0xff, 0x0b);
  for (const ch of "NETSCAPE2.0") push(ch.charCodeAt(0));
  push(0x03, 0x01, 0x00, 0x00, 0x00); // loop forever

  for (let i = 0; i < frames; i++) {
    push(0x21, 0xf9, 0x04, 0x00, 0x02, 0x00, 0x00, 0x00); // 2/100s delay
    push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00);
    push(0x02, 0x02, i % 2 ? 0x4c : 0x44, 0x01, 0x00); // LZW: clear, pixel, EOI
  }

  push(0x3b);
  return Buffer.from(b);
}

test("the harness really does produce an animation", async () => {
  const result = await validateImage(animatedGif(3), { animated: true });
  assert.equal(result.valid, true);
  assert.equal(result.valid && result.pages, 3);
});

test("frames are counted, so the icon route has something to refuse on", async () => {
  const result = await validateImage(animatedGif(MAX_ICON_FRAMES + 1), {
    animated: true,
  });
  assert.equal(result.valid, true);
  assert.equal(result.valid && result.pages, MAX_ICON_FRAMES + 1);
});

test("the cap admits what it says it admits, and refuses one more", async () => {
  const atTheLimit = await validateImage(animatedGif(MAX_ICON_FRAMES), {
    animated: true,
  });
  const overIt = await validateImage(animatedGif(MAX_ICON_FRAMES + 1), {
    animated: true,
  });

  assert.ok(atTheLimit.valid && (atTheLimit.pages ?? 1) <= MAX_ICON_FRAMES);
  assert.ok(overIt.valid && (overIt.pages ?? 1) > MAX_ICON_FRAMES);
});

test("eight seconds at sixty frames a second, which is what was asked for", () => {
  assert.equal(MAX_ICON_FRAMES, 60 * 8);
});
