import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_SCREEN_SHARES, screenSharesFrom } from "./screenShares";

describe("screenSharesFrom", () => {
  it("reads the single pair an older app sends", () => {
    assert.deepEqual(screenSharesFrom({ enabled: true, videoStreamId: "v", audioStreamId: "a" }), [{ videoStreamID: "v", audioStreamID: "a" }]);
  });

  it("reads every window from shares", () => {
    const shares = [{ videoStreamId: "v1", audioStreamId: "a1" }, { videoStreamId: "v2" }];
    assert.deepEqual(screenSharesFrom({ enabled: true, shares }), [
      { videoStreamID: "v1", audioStreamID: "a1" },
      { videoStreamID: "v2", audioStreamID: "" },
    ]);
  });

  it("drops what is malformed and stops at the ceiling", () => {
    const shares = [null, 5, { videoStreamId: 7 }, { videoStreamId: "x".repeat(200) }, ...Array.from({ length: 20 }, (_, i) => ({ videoStreamId: `v${i}` }))];
    const out = screenSharesFrom({ enabled: true, shares });
    assert.ok(out.length <= MAX_SCREEN_SHARES);
    assert.ok(out.every((s) => s.videoStreamID.startsWith("v")));
    assert.deepEqual(screenSharesFrom("yes"), []);
    assert.deepEqual(screenSharesFrom({ enabled: true }), []);
  });
});
