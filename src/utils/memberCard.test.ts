import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CARD_LIMITS,
  normaliseCardStyle,
  normaliseCardText,
  readCardUpdate,
  readStoredCardStyle,
  setsCardText,
} from "./memberCard";

/** Any client can send these, and every member draws them. So the cases are what
    a modified client sends, and the answer is always a card that draws. */

describe("a card style", () => {
  it("keeps a gradient with everything set", () => {
    assert.deepEqual(
      normaliseCardStyle({
        fill: "gradient",
        c1: "#FFD400",
        c2: "#3355aa",
        angle: 90,
        pattern: "dots",
        cover: "card",
        fade: "banner",
        colours: "banner",
      }),
      { fill: "gradient", c1: "#ffd400", c2: "#3355aa", angle: 90, pattern: "dots", cover: "card", fade: "banner", colours: "banner" },
    );
  });

  it("is nothing when every value is the default", () => {
    assert.equal(
      normaliseCardStyle({ fill: "owl", pattern: "none", cover: "banner", fade: "bottom", colours: "card" }),
      null,
    );
    assert.equal(normaliseCardStyle({}), null);
  });

  it("is nothing when it is not an object", () => {
    for (const value of [null, undefined, "fill=solid", 7, true, [{ fill: "solid", c1: "#ffffff" }]]) {
      assert.equal(normaliseCardStyle(value), null, JSON.stringify(value));
    }
  });

  it("drops keys it does not know", () => {
    assert.deepEqual(normaliseCardStyle({ pattern: "dots", banner: "file_1", css: "url(x)" }), { pattern: "dots" });
  });

  it("takes a colour with or without the hash", () => {
    assert.deepEqual(normaliseCardStyle({ fill: "solid", c1: "ABCDEF" }), { fill: "solid", c1: "#abcdef" });
  });

  it("goes back to the owl's colour when the colour will not parse", () => {
    for (const c1 of ["#fff", "red", "#gggggg", "#ffd4001", "rgb(1,2,3)", "", 0xffd400]) {
      assert.equal(normaliseCardStyle({ fill: "solid", c1 }), null, String(c1));
    }
  });

  it("makes a gradient missing its second colour a solid one", () => {
    assert.deepEqual(
      normaliseCardStyle({ fill: "gradient", c1: "#ffd400", c2: "nope", angle: 45 }),
      { fill: "solid", c1: "#ffd400" },
    );
  });

  it("drops colours the fill does not use", () => {
    assert.equal(normaliseCardStyle({ fill: "owl", c1: "#ffd400", c2: "#000000" }), null);
    assert.deepEqual(normaliseCardStyle({ fill: "solid", c1: "#ffd400", c2: "#000000", angle: 45 }), {
      fill: "solid",
      c1: "#ffd400",
    });
  });

  it("drops an angle out of range or not whole", () => {
    for (const angle of [-1, 361, 45.5, Number.NaN, Infinity, "90"]) {
      assert.deepEqual(
        normaliseCardStyle({ fill: "gradient", c1: "#111111", c2: "#222222", angle }),
        { fill: "gradient", c1: "#111111", c2: "#222222" },
        String(angle),
      );
    }
    assert.equal(normaliseCardStyle({ fill: "gradient", c1: "#111111", c2: "#222222", angle: 360 })?.angle, 360);
    assert.equal(normaliseCardStyle({ fill: "gradient", c1: "#111111", c2: "#222222", angle: 0 })?.angle, 0);
  });

  it("keeps a pattern id it has never heard of", () => {
    // The registry grows on the client. An old server must still pass new ids on.
    assert.deepEqual(normaliseCardStyle({ pattern: "aurora-2" }), { pattern: "aurora-2" });
  });

  it("drops a pattern id that is not a short slug", () => {
    for (const pattern of ["Dots", "dots dots", "../x", "a".repeat(33), "", "dots‮", 3]) {
      assert.equal(normaliseCardStyle({ pattern }), null, String(pattern));
    }
  });

  it("drops a bad value without losing the good ones", () => {
    assert.deepEqual(
      normaliseCardStyle({ fill: "plaid", pattern: "weave", cover: "everything", fade: "banner", colours: 1 }),
      { pattern: "weave", fade: "banner" },
    );
  });
});

describe("pattern tuning", () => {
  const all = { pScale: 150, pRotate: 45, pOpacity: 12, pFade: "radial", pSeed: 4242, pInk: "#AABBCC" };

  it("keeps every tuning value in range", () => {
    assert.deepEqual(normaliseCardStyle({ pattern: "dots", ...all }), {
      pattern: "dots",
      ...all,
      pInk: "#aabbcc",
    });
  });

  it("leaves out the defaults it has", () => {
    assert.equal(normaliseCardStyle({ pScale: 100, pRotate: 0, pFade: "none" }), null);
  });

  it("keeps values that have no server default, at the edges of their range", () => {
    assert.deepEqual(normaliseCardStyle({ pOpacity: 3, pSeed: 0, pScale: 50, pRotate: 359 }), {
      pOpacity: 3,
      pSeed: 0,
      pScale: 50,
      pRotate: 359,
    });
    assert.deepEqual(normaliseCardStyle({ pOpacity: 40, pSeed: 65535, pScale: 300 }), {
      pOpacity: 40,
      pSeed: 65535,
      pScale: 300,
    });
  });

  it("drops each bad value and keeps the rest", () => {
    const bad: Array<[string, unknown]> = [
      ["pScale", 49], ["pScale", 301], ["pScale", 120.5], ["pScale", "150"],
      ["pRotate", -1], ["pRotate", 360], ["pRotate", 1.5],
      ["pOpacity", 2], ["pOpacity", 41], ["pOpacity", null],
      ["pFade", "diagonal"], ["pFade", "Top"], ["pFade", 1],
      ["pSeed", -1], ["pSeed", 65536], ["pSeed", 3.3],
      ["pInk", "#abc"], ["pInk", "ink"], ["pInk", 0xaabbcc],
      ["pIcon", "Heart"], ["pIcon", "heart fill"], ["pIcon", "a".repeat(49)], ["pIcon", ""], ["pIcon", 7],
    ];
    for (const [key, value] of bad) {
      assert.deepEqual(normaliseCardStyle({ pattern: "dots", [key]: value }), { pattern: "dots" }, `${key}=${String(value)}`);
    }
  });
});

describe("line weight, the pattern's layer and the outline", () => {
  it("keeps each in range and leaves out the defaults", () => {
    assert.deepEqual(normaliseCardStyle({ pattern: "waves-1", pStroke: 220, pLayer: "front", edge: 3 }), {
      pattern: "waves-1",
      pStroke: 220,
      pLayer: "front",
      edge: 3,
    });
    assert.deepEqual(normaliseCardStyle({ pStroke: 40, edge: 0 }), { pStroke: 40, edge: 0 });
    assert.deepEqual(normaliseCardStyle({ pStroke: 300, edge: 6 }), { pStroke: 300, edge: 6 });
    assert.equal(normaliseCardStyle({ pStroke: 100, edge: 1, pLayer: "behind" }), null);
  });

  it("drops each bad value and keeps the rest", () => {
    const bad: Array<[string, unknown]> = [
      ["pStroke", 39], ["pStroke", 301], ["pStroke", 120.5], ["pStroke", "150"],
      ["pLayer", "top"], ["pLayer", true],
      ["edge", -1], ["edge", 7], ["edge", 1.5], ["edge", "2"],
    ];
    for (const [key, value] of bad) {
      assert.deepEqual(normaliseCardStyle({ pattern: "dots", [key]: value }), { pattern: "dots" }, `${key}=${String(value)}`);
    }
  });
});

describe("the banner's fade", () => {
  it("keeps the whole-banner fade and no fade, and leaves out the bottom one", () => {
    assert.deepEqual(normaliseCardStyle({ fade: "banner" }), { fade: "banner" });
    assert.deepEqual(normaliseCardStyle({ fade: "none" }), { fade: "none" });
    assert.equal(normaliseCardStyle({ fade: "bottom" }), null);
    assert.equal(normaliseCardStyle({ fade: "sideways" }), null);
  });
});

describe("the plain card as a choice", () => {
  it("is kept when it is the whole style, so it isn't read as no card", () => {
    assert.deepEqual(normaliseCardStyle({ plain: true }), { plain: true });
    assert.deepEqual(readStoredCardStyle(JSON.stringify({ plain: true })), { plain: true });
  });

  it("is dropped next to a colour or a pattern, and for anything but true", () => {
    assert.deepEqual(normaliseCardStyle({ plain: true, pattern: "dots" }), { pattern: "dots" });
    assert.equal(normaliseCardStyle({ plain: "yes" }), null);
    assert.equal(normaliseCardStyle({ plain: false }), null);
  });
});

describe("an icon for the icon pattern", () => {
  it("keeps any Phosphor-shaped name, known or not", () => {
    assert.deepEqual(normaliseCardStyle({ pattern: "icon", pIcon: "game-controller" }), { pattern: "icon", pIcon: "game-controller" });
    assert.equal(normaliseCardStyle({ pIcon: "a".repeat(48) })?.pIcon, "a".repeat(48));
  });
});

describe("a stored card style", () => {
  it("reads back what was stored", () => {
    const style = normaliseCardStyle({ fill: "solid", c1: "#ffd400", pattern: "dusk" });
    assert.deepEqual(readStoredCardStyle(JSON.stringify(style)), style);
  });

  it("is nothing when the column is empty or garbled", () => {
    assert.equal(readStoredCardStyle(null), null);
    assert.equal(readStoredCardStyle(""), null);
    assert.equal(readStoredCardStyle("{not json"), null);
    assert.equal(readStoredCardStyle('"a string"'), null);
  });
});

describe("the card's text", () => {
  it("strips newlines and the characters that can cover somebody else's row", () => {
    assert.equal(normaliseCardText("  she/‮her\n", CARD_LIMITS.pronouns), "she/ her");
    assert.equal(normaliseCardText("a​b", CARD_LIMITS.bio), "a b");
  });

  it("cuts to the limit, ellipsis included", () => {
    for (const [field, max] of Object.entries(CARD_LIMITS)) {
      const cut = normaliseCardText("x".repeat(max + 50), max);
      assert.equal(cut?.length, max, field);
      assert.ok(cut?.endsWith("…"), field);
      assert.equal(normaliseCardText("x".repeat(max), max), "x".repeat(max), field);
    }
  });

  it("is nothing when empty, blank or not text", () => {
    for (const value of ["", "   ", "​​", null, 12, { text: "hi" }]) {
      assert.equal(normaliseCardText(value, 80), null, JSON.stringify(value));
    }
  });
});

describe("a profile update", () => {
  it("leaves a field alone when it is not sent", () => {
    assert.deepEqual(readCardUpdate({ nickname: "Alice" }), {});
    assert.deepEqual(readCardUpdate(undefined), {});
  });

  it("clears a field sent as null or empty", () => {
    assert.deepEqual(readCardUpdate({ cardStyle: null, bio: "", pronouns: null, statusLine: "  " }), {
      cardStyle: null,
      bio: null,
      pronouns: null,
      statusLine: null,
    });
  });

  it("stores the cleaned style, not what was sent", () => {
    const update = readCardUpdate({ cardStyle: { fill: "solid", c1: "FFD400", evil: "x" } });
    assert.equal(update.cardStyle, JSON.stringify({ fill: "solid", c1: "#ffd400" }));
  });

  it("stores a style that is all defaults as nothing", () => {
    assert.deepEqual(readCardUpdate({ cardStyle: { fill: "owl" } }), { cardStyle: null });
  });

  it("knows a clear from new text", () => {
    assert.equal(setsCardText(readCardUpdate({ bio: "", pronouns: null })), false);
    assert.equal(setsCardText(readCardUpdate({ cardStyle: { pattern: "dots" } })), false);
    assert.equal(setsCardText(readCardUpdate({ statusLine: "brb" })), true);
  });
});
