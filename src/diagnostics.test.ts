import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSfuMetrics, sfuMetricsUrl } from "./diagnostics";

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

describe("sfuMetricsUrl", () => {
  it("prefers SFU_METRICS_URL, and otherwise guesses port 9091 on the SFU's host", () => {
    assert.equal(sfuMetricsUrl({ SFU_METRICS_URL: "http://x:1/m", SFU_WS_HOST: "ws://sfu:9092" }), "http://x:1/m");
    assert.equal(sfuMetricsUrl({ SFU_WS_HOST: "ws://sfu:9092" }), "http://sfu:9091/metrics");
    assert.equal(sfuMetricsUrl({ SFU_WS_HOST: "wss://sfu.example.com" }), "http://sfu.example.com:9091/metrics");
    assert.equal(sfuMetricsUrl({ SFU_WS_HOST: "ws://[::1]:9092" }), "http://[::1]:9091/metrics");
    assert.equal(sfuMetricsUrl({}), undefined);
  });
});
