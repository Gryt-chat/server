import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normaliseChannelColor, normaliseChannelPoster, readStoredChannelPoster } from "./channelPoster";

describe("a channel poster", () => {
  it("keeps a full design", () => {
    assert.deepEqual(
      normaliseChannelPoster({ layout: "classic", fill: "gradient", c1: "#5B4FD6", c2: "2a2560", angle: 135, pattern: "contours" }),
      { layout: "classic", fill: "gradient", c1: "#5b4fd6", c2: "#2a2560", angle: 135, pattern: "contours" },
    );
  });

  it("keeps a layout with nothing else", () => {
    assert.deepEqual(normaliseChannelPoster({ layout: "quiet" }), { layout: "quiet" });
  });

  it("is no poster without a known layout", () => {
    assert.equal(normaliseChannelPoster({ fill: "solid", c1: "#ffffff" }), null);
    assert.equal(normaliseChannelPoster({ layout: "huge" }), null);
    assert.equal(normaliseChannelPoster("classic"), null);
    assert.equal(normaliseChannelPoster([{ layout: "classic" }]), null);
  });

  it("drops bad values and keys it does not know", () => {
    assert.deepEqual(
      normaliseChannelPoster({ layout: "centred", fill: "solid", c1: "red", pattern: "<svg>", picture: "f_1", angle: 900 }),
      { layout: "centred" },
    );
  });

  it("reads back what was stored, and nothing from a broken row", () => {
    assert.deepEqual(readStoredChannelPoster('{"layout":"classic","fill":"solid","c1":"#112233"}'), { layout: "classic", fill: "solid", c1: "#112233" });
    assert.equal(readStoredChannelPoster("{nope"), null);
    assert.equal(readStoredChannelPoster(null), null);
  });
});

describe("a channel colour", () => {
  it("is a lower-case hex or nothing", () => {
    assert.equal(normaliseChannelColor("FFD27A"), "#ffd27a");
    assert.equal(normaliseChannelColor("#ffd27a"), "#ffd27a");
    assert.equal(normaliseChannelColor("yellow"), null);
    assert.equal(normaliseChannelColor(null), null);
  });
});
