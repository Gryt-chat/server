import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkButtonUrl, normaliseRichActivity, RICH_LIMITS } from "./richActivity";

/**
 * Any program on somebody's machine can write this card, and every member of
 * every server they are on reads it. So the cases are what a hostile program sends.
 */

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

describe("a card from a game", () => {
  it("keeps every field a card may draw", () => {
    const card = normaliseRichActivity(
      {
        type: "playing",
        name: "World of Warcraft",
        details: "Thragg - Level 14 Warlock",
        state: "Westfall",
        startedAt: NOW - 86_000,
        party: { size: 2, max: 5 },
        buttons: [{ label: "Armory", url: "https://worldofwarcraft.blizzard.com/character/eu/x" }],
      },
      NOW,
    );
    assert.deepEqual(card, {
      type: "playing",
      name: "World of Warcraft",
      details: "Thragg - Level 14 Warlock",
      state: "Westfall",
      startedAt: NOW - 86_000,
      party: { size: 2, max: 5 },
      buttons: [{ label: "Armory", url: "https://worldofwarcraft.blizzard.com/character/eu/x" }],
    });
  });

  it("drops anything outside the shape", () => {
    const card = normaliseRichActivity(
      { name: "Factorio", assets: { large_image: "https://evil.example/pixel.png" }, secrets: { join: "x" }, instance: true },
      NOW,
    );
    assert.deepEqual(card, { type: "playing", name: "Factorio" });
  });

  it("is null with no name, since a card has to say what it is", () => {
    for (const bad of [null, undefined, "Factorio", 42, [], {}, { name: "   " }, { name: 7 }, { details: "x" }]) {
      assert.equal(normaliseRichActivity(bad, NOW), null, JSON.stringify(bad));
    }
  });

  it("falls back to playing for a type it does not know", () => {
    assert.equal(normaliseRichActivity({ name: "x", type: "streaming" }, NOW)?.type, "playing");
    assert.equal(normaliseRichActivity({ name: "x", type: "listening" }, NOW)?.type, "listening");
  });
});

describe("text on the card", () => {
  it("is cut to its limit with an ellipsis", () => {
    const card = normaliseRichActivity({ name: "n".repeat(500), details: "d".repeat(500), state: "s".repeat(500) }, NOW);
    assert.equal(card?.name.length, RICH_LIMITS.name);
    assert.equal(card?.details?.length, RICH_LIMITS.details);
    assert.equal(card?.state?.length, RICH_LIMITS.state);
    assert.ok(card?.name.endsWith("…"));
  });

  it("loses newlines and direction overrides, which would spill into other rows", () => {
    const card = normaliseRichActivity({ name: "Game\nAdmin", details: "a‮b", state: "​​" }, NOW);
    assert.equal(card?.name, "Game Admin");
    assert.equal(card?.details, "a b");
    assert.equal(card?.state, undefined);
  });
});

describe("the timer", () => {
  it("drops a start in the future, beyond a minute of clock drift", () => {
    assert.equal(normaliseRichActivity({ name: "x", startedAt: NOW + 3_600_000 }, NOW)?.startedAt, undefined);
    assert.equal(normaliseRichActivity({ name: "x", startedAt: NOW + 30_000 }, NOW)?.startedAt, NOW);
  });

  it("drops a start more than a week ago", () => {
    assert.equal(normaliseRichActivity({ name: "x", startedAt: NOW - 8 * 86_400_000 }, NOW)?.startedAt, undefined);
  });

  it("drops what is not a number", () => {
    for (const bad of ["1700000000000", NaN, Infinity, null]) {
      assert.equal(normaliseRichActivity({ name: "x", startedAt: bad }, NOW)?.startedAt, undefined);
    }
  });
});

describe("party size", () => {
  it("takes whole numbers from 1 to 999", () => {
    assert.deepEqual(normaliseRichActivity({ name: "x", party: { size: 3 } }, NOW)?.party, { size: 3 });
    for (const bad of [0, -1, 1.5, 1000, "2"]) {
      assert.equal(normaliseRichActivity({ name: "x", party: { size: bad, max: 5 } }, NOW)?.party, undefined);
    }
  });

  it("keeps the size and drops a max smaller than it", () => {
    assert.deepEqual(normaliseRichActivity({ name: "x", party: { size: 5, max: 3 } }, NOW)?.party, { size: 5 });
  });
});

describe("buttons", () => {
  it("keeps two at most", () => {
    const buttons = [1, 2, 3].map((n) => ({ label: `B${n}`, url: `https://example.com/${n}` }));
    assert.equal(normaliseRichActivity({ name: "x", buttons }, NOW)?.buttons?.length, 2);
  });

  it("drops one with no label or a bad link, and keeps the good one", () => {
    const card = normaliseRichActivity(
      {
        name: "x",
        buttons: [
          { label: "", url: "https://example.com" },
          { label: "Join", url: "https://example.com/join" },
        ],
      },
      NOW,
    );
    assert.deepEqual(card?.buttons, [{ label: "Join", url: "https://example.com/join" }]);
  });

  it("drops the whole list when nothing in it is usable", () => {
    assert.equal(normaliseRichActivity({ name: "x", buttons: [{ label: "x", url: "javascript:alert(1)" }] }, NOW)?.buttons, undefined);
  });
});

describe("a button link", () => {
  it("is http or https to a public name", () => {
    assert.equal(checkButtonUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
    assert.equal(checkButtonUrl("http://example.com"), "http://example.com/");
  });

  const refused: Array<[string, string]> = [
    ["a script", "javascript:alert(1)"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["a file", "file:///etc/passwd"],
    ["a custom scheme", "steam://run/570"],
    ["an app deep link", "gryt://invite/abc"],
    ["credentials that disguise the host", "https://gryt.chat@evil.example/"],
    ["localhost", "http://localhost:5002/"],
    ["a router", "http://192.168.1.1/admin"],
    ["a public IP", "http://8.8.8.8/"],
    ["an IPv6 loopback", "http://[::1]/"],
    ["a bare LAN name", "http://nas/"],
    ["a .local name", "http://printer.localhost/"],
    ["a cloud metadata name", "http://metadata.google.internal/"],
    ["something too long", `https://example.com/${"a".repeat(600)}`],
    ["not a string", "" as unknown as string],
    ["garbage", "not a url"],
  ];

  for (const [what, url] of refused) {
    it(`refuses ${what}`, () => {
      assert.equal(checkButtonUrl(url), undefined);
    });
  }
});
