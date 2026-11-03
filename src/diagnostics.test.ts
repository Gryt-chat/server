import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSfuMetrics } from "./diagnostics";

describe("parseSfuMetrics", () => {
  it("keeps gryt_sfu series, sums labelled ones and drops the rest", () => {
    const text = [
      "# HELP gryt_sfu_peers_active Total peers",
      "# TYPE gryt_sfu_peers_active gauge",
      "gryt_sfu_peers_active 3",
      'gryt_sfu_tracks_refused_total{kind="video"} 2',
      'gryt_sfu_tracks_refused_total{kind="audio"} 1',
      "go_goroutines 41",
      "gryt_sfu_rooms_active NaN",
    ].join("\n");
    assert.deepEqual(parseSfuMetrics(text), {
      gryt_sfu_peers_active: 3,
      gryt_sfu_tracks_refused_total: 3,
    });
  });
});
