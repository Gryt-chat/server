import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_ACTIVITY_LENGTH, normaliseActivity } from "./activityText";

/**
 * What somebody may put in "what I'm doing" (GRYT-929).
 *
 * Two things make this worth more than a trim. It is free text on a member row
 * shown to everybody on the server, and — once plugins can set it — the bytes
 * are chosen by arbitrary JavaScript running in somebody's client rather than
 * typed by a person. So the cases that matter are the ones nobody would type
 * on purpose.
 */

describe("an ordinary status", () => {
  it("comes through as written", () => {
    assert.equal(
      normaliseActivity("Listening to Bohemian Rhapsody — Queen"),
      "Listening to Bohemian Rhapsody — Queen",
    );
  });

  it("keeps emoji, which is most of what people put in one", () => {
    assert.equal(normaliseActivity("🎧 deep work"), "🎧 deep work");
  });

  it("is trimmed and collapsed rather than left ragged", () => {
    assert.equal(normaliseActivity("  spaced   out  "), "spaced out");
  });
});

/*
 * Null is "not set", and it is also how somebody takes theirs down — clearing
 * goes through the same door as setting rather than needing an event of its
 * own.
 */
describe("nothing to say", () => {
  for (const empty of ["", "   ", "\n", "\t\t", "\u200B", null, undefined, 42, {}, []]) {
    it(`is null for ${JSON.stringify(empty)}`, () => {
      assert.equal(normaliseActivity(empty), null);
    });
  }
});

/*
 * The half this exists for.
 *
 * A member list is a column of names, and this is the one field in it whose
 * bytes somebody else picks. A newline makes one row into two; a
 * right-to-left override reverses the names around it; a zero-width run pads a
 * status out of its own row without looking long.
 */
describe("things that would break the row", () => {
  it("makes one line out of several", () => {
    assert.equal(normaliseActivity("line\nbreak"), "line break");
    assert.equal(normaliseActivity("a\r\nb\tc"), "a b c");
  });

  it("takes out the invisible characters", () => {
    assert.equal(normaliseActivity("zero\u200Bwidth"), "zero width");
    assert.equal(normaliseActivity("\uFEFFbom"), "bom");
  });

  it("takes out the direction overrides", () => {
    for (const trick of ["\u202E", "\u202D", "\u2066", "\u2069", "\u200F"]) {
      const out = normaliseActivity(`rtl${trick}override`);
      assert.equal(out, "rtl override", `left ${JSON.stringify(trick)} in`);
    }
  });

  /* Replaced with a space rather than deleted, so two words either side do not
     become one — "Queen\u200BBohemian" is not "QueenBohemian". */
  it("does not glue words together when it removes one", () => {
    assert.equal(normaliseActivity("Queen\u200BBohemian"), "Queen Bohemian");
  });

  it("leaves no control characters behind at all", () => {
    const control =
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;
    const nasty = "a\u0000b\u001Fcd e\u202Af";
    assert.doesNotMatch(normaliseActivity(nasty) ?? "", control);
  });
});

/*
 * Truncated rather than refused. A plugin sending a long track name is not
 * misbehaving, and a status that silently fails to appear is harder to explain
 * than one a little shorter than expected.
 */
describe("something far too long", () => {
  it("is cut to the cap, ellipsis included", () => {
    const out = normaliseActivity("x".repeat(500));
    assert.ok(out);
    assert.equal(out.length, MAX_ACTIVITY_LENGTH, "the cap is the whole string, not the text before it");
    assert.ok(out.endsWith("…"));
  });

  it("leaves something exactly at the cap alone", () => {
    const exact = "y".repeat(MAX_ACTIVITY_LENGTH);
    assert.equal(normaliseActivity(exact), exact);
  });

  /* Long only because of whitespace is not long. Collapsing happens first, so
     a padded short status is not needlessly cut. */
  it("measures after collapsing, not before", () => {
    const padded = `a${" ".repeat(400)}b`;
    assert.equal(normaliseActivity(padded), "a b");
  });
});
