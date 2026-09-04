import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  makerWorld,
  makerWorldModelId,
  resolverFor,
  summaryToText,
  withOssResize,
} from "./linkResolvers";

/**
 * The site-specific half of link previews (GRYT-913).
 *
 * A resolver runs instead of reading a page, so the failure that matters is not
 * "it got the title wrong" — it is a resolver that claims a URL it cannot
 * answer, or returns half a card, and so replaces a working OpenGraph fetch
 * with a worse one. Most of this file is about it returning null.
 *
 * No network. `resolve` takes its fetcher as an argument precisely so this can
 * hand it a function that returns whatever the case is about.
 */

const MODEL = "https://makerworld.com/en/models/1642496-old-vikings-jewelry-box";

/** Trimmed from the real 86 KB answer, 2026-09-04. */
const DESIGN = {
  id: 1642496,
  title: "Old Vikings Jewelry Box",
  summary: "<p>SKOL</p><p>&nbsp;</p><p>die Silberne Box</p>",
  coverUrl:
    "https://makerworld.bblmw.com/makerworld/model/USc2288dd345d5c5/design/2025-07-31_f2d4e3ba416b2.jpg",
  createTime: "2025-07-26T19:24:08Z",
  designCreator: { uid: 1634129376, name: "Mr. Anderson" },
};

const never = async () => {
  throw new Error("the resolver made a request it should not have");
};

describe("which URLs a resolver claims", () => {
  it("takes a model page, with or without a locale", () => {
    for (const url of [
      "https://makerworld.com/en/models/1642496-old-vikings-jewelry-box",
      "https://makerworld.com/de/models/1642496-anything",
      "https://makerworld.com/models/1642496",
      "https://www.makerworld.com/en/models/1642496-x",
      "https://makerworld.com/en/models/1642496-x?appSharePlatform=copy#profileId-1735650",
    ]) {
      assert.ok(resolverFor(new URL(url)), `should have claimed ${url}`);
      assert.equal(makerWorldModelId(new URL(url)), "1642496");
    }
  });

  /*
   * The half that keeps this cheap. A resolver that claimed every MakerWorld
   * URL would spend a request on a search page to discover it has no model id,
   * and would then have to fall back anyway.
   */
  it("leaves alone anything that is not a model", () => {
    for (const url of [
      "https://makerworld.com/en",
      "https://makerworld.com/en/search?q=box",
      "https://makerworld.com/en/@someone",
      "https://makerworld.com/en/models/",
      "https://makerworld.com/en/models/not-a-number",
      "https://makerworld.com/en/models/abc-1642496",
    ]) {
      assert.equal(resolverFor(new URL(url)), null, `should have skipped ${url}`);
    }
  });

  it("claims nothing on another host", () => {
    for (const url of [
      "https://example.com/en/models/1642496-x",
      "https://makerworld.com.evil.test/en/models/1642496-x",
      "https://notmakerworld.com/en/models/1642496-x",
    ]) {
      assert.equal(resolverFor(new URL(url)), null, `should have skipped ${url}`);
    }
  });
});

describe("what it makes of a good answer", () => {
  it("fills the card", async () => {
    const meta = await makerWorld.resolve(new URL(MODEL), async () => DESIGN);
    assert.ok(meta);
    assert.equal(meta.title, "Old Vikings Jewelry Box");
    assert.equal(meta.description, "SKOL die Silberne Box");
    assert.equal(meta.siteName, "MakerWorld");
    assert.equal(meta.author, "Mr. Anderson");
    assert.equal(meta.publishedAt, "2025-07-26T19:24:08Z");
  });

  it("asks the endpoint for the id in the URL", async () => {
    const asked: string[] = [];
    await makerWorld.resolve(new URL(MODEL), async (t) => {
      asked.push(t);
      return DESIGN;
    });
    assert.deepEqual(asked, [
      "https://makerworld.com/api/v1/design-service/design/1642496",
    ]);
  });

  /*
   * The raw cover is 1.68 MB and arrives as application/octet-stream. The card
   * has to ask for something an <img> will take.
   */
  it("asks the CDN for a card-sized webp rather than the original", async () => {
    const meta = await makerWorld.resolve(new URL(MODEL), async () => DESIGN);
    const image = new URL(meta!.image!);
    assert.equal(image.searchParams.get("x-oss-process"), "image/resize,w_640/format,webp");
    assert.equal(image.pathname, new URL(DESIGN.coverUrl).pathname);
  });

  it("replaces processing parameters rather than stacking a second set", async () => {
    const already = `${DESIGN.coverUrl}?x-oss-process=image%2Fresize%2Cw_100`;
    const meta = await makerWorld.resolve(new URL(MODEL), async () => ({
      ...DESIGN,
      coverUrl: already,
    }));
    const values = new URL(meta!.image!).searchParams.getAll("x-oss-process");
    assert.equal(values.length, 1);
    assert.equal(values[0], "image/resize,w_640/format,webp");
  });
});

/*
 * Everything here has to come back null so the caller falls through to the
 * ordinary OpenGraph fetch. A resolver that returns a half-filled object is
 * worse than one that returns nothing: it replaces a working card with a
 * broken one, and the fallback never runs.
 */
describe("when the answer is not one", () => {
  const bad: [string, unknown][] = [
    ["null", null],
    ["a string", "nope"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["an error page shape", { error: "not_found", message: "no such design" }],
    ["a design with neither title nor cover", { id: 1, summary: "<p>hi</p>" }],
    ["title and cover both blank", { title: "   ", coverUrl: "" }],
  ];

  for (const [what, body] of bad) {
    it(`returns null for ${what}`, async () => {
      const meta = await makerWorld.resolve(new URL(MODEL), async () => body);
      assert.equal(meta, null);
    });
  }

  it("returns null rather than throwing when the URL has no id", async () => {
    const meta = await makerWorld.resolve(
      new URL("https://makerworld.com/en/search"),
      never,
    );
    assert.equal(meta, null);
  });

  /* One of the two is enough to be a real answer — a model with no cover still
     has a name worth drawing. */
  it("takes a title with no cover", async () => {
    const meta = await makerWorld.resolve(new URL(MODEL), async () => ({ title: "Box" }));
    assert.equal(meta?.title, "Box");
    assert.equal(meta?.image, null);
  });

  it("drops a cover that is not a URL rather than passing it through", async () => {
    const meta = await makerWorld.resolve(new URL(MODEL), async () => ({
      title: "Box",
      coverUrl: "not a url",
    }));
    assert.equal(meta?.image, null);
  });
});

describe("their summary, which is rich text", () => {
  it("comes out as one line of prose", () => {
    assert.equal(summaryToText("<p>SKOL</p><p>&nbsp;</p><p>die Box</p>"), "SKOL die Box");
    assert.equal(summaryToText("a<br>b"), "a b");
    /* Not only <p> and <br>. A summary is a WYSIWYG field, so it carries
       links, images and spans, and any tag left in reaches the card as
       literal markup. */
    assert.equal(
      summaryToText('<a href="https://x.test">click</a> and <img src="y"> <span>more</span>'),
      "click and more",
    );
    assert.equal(summaryToText("&amp; &lt;b&gt; &quot;x&quot;"), '& <b> "x"');
  });

  it("is null when there is nothing left", () => {
    for (const empty of ["", "   ", "<p></p>", "<p>&nbsp;</p>", null, undefined, 42]) {
      assert.equal(summaryToText(empty), null, `expected null for ${JSON.stringify(empty)}`);
    }
  });

  it("is cut to length with an ellipsis", () => {
    const long = summaryToText("x".repeat(500));
    assert.equal(long?.length, 300);
    assert.ok(long?.endsWith("…"));
  });
});

describe("withOssResize", () => {
  it("returns null rather than a broken string for a non-URL", () => {
    for (const bad of ["", "not a url", "/relative/path.jpg"]) {
      assert.equal(withOssResize(bad), null);
    }
  });

  it("keeps everything else about the URL", () => {
    const out = new URL(withOssResize("https://cdn.test/a/b.jpg?v=2")!);
    assert.equal(out.host, "cdn.test");
    assert.equal(out.pathname, "/a/b.jpg");
    assert.equal(out.searchParams.get("v"), "2");
  });
});
