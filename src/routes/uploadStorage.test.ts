import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { isSealedUpload, storageForUpload } from "./uploadStorage";

/**
 * A sealed upload skips validation, and keeping the client's content type while
 * doing so serves ciphertext labelled `image/svg+xml` inline from this origin.
 */

const base = { fileId: "abc", mimetype: "image/png", originalName: "cat.png" };

describe("isSealedUpload", () => {
  it("is exactly \"1\"", () => {
    assert.equal(isSealedUpload({ sealed: "1" }), true);
  });

  it("is false for everything else a form field can be", () => {
    // A flag, not a guess: ciphertext is indistinguishable from noise, so
    // anything unrecognised has to mean the validated path.
    for (const value of ["0", "", "true", "false", "yes", 1, true, null, undefined, {}]) {
      assert.equal(isSealedUpload({ sealed: value }), false, `${String(value)} was taken as sealed`);
    }
    assert.equal(isSealedUpload(undefined), false);
    assert.equal(isSealedUpload(null), false);
    assert.equal(isSealedUpload({}), false);
  });
});

describe("a sealed upload", () => {
  it("is stored as an opaque blob whatever it claims to be", () => {
    // All of these are the client's claims and none is validated.
    // `application/octet-stream` is outside `isInlineSafe`.
    for (const mimetype of [
      "image/svg+xml",
      "image/png",
      "text/html",
      "application/javascript",
      undefined,
    ]) {
      const storage = storageForUpload({ ...base, sealed: true, mimetype });

      assert.equal(storage.storedMime, "application/octet-stream", `${mimetype} survived`);
      assert.equal(storage.key, "uploads/abc.bin");
      assert.equal(storage.treatAsSvg, false, "a sealed upload must never reach the SVG path");
      assert.equal(storage.validateAsImage, false, "there is no picture to validate");
      assert.equal(storage.extractVideoThumbnail, false);
      assert.equal(storage.queueImageJob, false, "the worker would hand ciphertext to sharp");
    }
  });

  it("does not record the filename", () => {
    // The real one is in the sealed message with the key. A filename says a
    // great deal, and it goes out with every message naming the attachment.
    const storage = storageForUpload({ ...base, sealed: true, originalName: "medical-results.pdf" });

    assert.equal(storage.originalName, null);
    assert.ok(!storage.key.includes("medical"), "nor in the object key");
  });
});

describe("an ordinary upload", () => {
  it("is unchanged", () => {
    const png = storageForUpload({ ...base, sealed: false });

    assert.equal(png.storedMime, "image/png");
    assert.equal(png.key, "uploads/abc.png");
    assert.equal(png.originalName, "cat.png");
    assert.equal(png.validateAsImage, true);
    assert.equal(png.queueImageJob, true);
    assert.equal(png.treatAsSvg, false);
    assert.equal(png.extractVideoThumbnail, false);
  });

  it("sends an SVG to the sanitiser and never to the worker", () => {
    // The worker hands its input to sharp, which renders SVG through librsvg.
    // Used to be true only by control flow in the route.
    const svg = storageForUpload({ ...base, sealed: false, mimetype: "image/svg+xml" });

    assert.equal(svg.treatAsSvg, true);
    assert.equal(svg.validateAsImage, false, "sharp must not decode it");
    assert.equal(svg.queueImageJob, false, "and the worker must not either");
  });

  it("pulls a poster frame out of a video", () => {
    const video = storageForUpload({ ...base, sealed: false, mimetype: "video/mp4" });

    assert.equal(video.extractVideoThumbnail, true);
    assert.equal(video.validateAsImage, false);
    assert.equal(video.queueImageJob, false);
  });

  it("falls back to .bin for a type with no known extension", () => {
    const odd = storageForUpload({ ...base, sealed: false, mimetype: "application/x-nonsense" });

    assert.equal(odd.key, "uploads/abc.bin");
    assert.equal(odd.storedMime, "application/x-nonsense");
  });

  it("records no name when the client sent none", () => {
    assert.equal(
      storageForUpload({ ...base, sealed: false, originalName: undefined }).originalName,
      null,
    );
    assert.equal(
      storageForUpload({ ...base, sealed: false, originalName: "" }).originalName,
      null,
    );
  });
});

describe("the route uses it", () => {
  /** `uploads.ts` cannot be imported here, so this reads it: a decision not
      asked for over there passes every assertion above. */
  // `__dirname` rather than `import.meta.url`, which does not compile under
  // `ts-node/register` in CommonJS.
  const file = readFileSync(join(__dirname, "uploads.ts"), "utf8");

  /** The attachment route only. The avatar route's own `insertFile` calls are
      unreachable with a sealed upload and would fail this for no reason. */
  const routeStart = file.indexOf("uploadsRouter.post(");
  const routeEnd = file.indexOf("uploadsRouter.post(", routeStart + 1);
  const source = file.slice(routeStart, routeEnd);

  it("asks for the decision rather than working it out again", () => {
    assert.match(source, /storageForUpload\(\{/, "the route no longer calls storageForUpload");
    assert.match(source, /sealed: isSealedUpload\(req\.body\)/, "the flag is not read off the request");
  });

  it("stores what the decision said, not what the client sent", () => {
    // `file.mimetype` reaching the `files` row is the stored-XSS shape. Every
    // `insertFile`, not the first: the route has two.
    const rows = source
      .split("await insertFile({")
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf("});")));

    assert.equal(rows.length, 2, "an insertFile was added or removed; check it too");

    for (const row of rows) {
      assert.doesNotMatch(row, /file\.mimetype/, "the client's content type reached a row");
      assert.doesNotMatch(row, /file\.originalname/, "the client's filename reached a row");
      assert.match(row, /original_name: storage\.originalName/);
    }

    // The general branch. The SVG one writes the literal type it sanitised to,
    // which is not the client's and is the point of that branch.
    assert.ok(
      rows.some((row) => /mime: storedMime/.test(row)),
      "no row records the decided content type",
    );
  });

  it("gates every side effect on the decision", () => {
    // Each of these needs the picture. A sealed upload has ciphertext, and
    // sharp, ffmpeg and the SVG sanitiser would each be handed it.
    for (const [what, gate] of [
      ["the SVG sanitiser", "if (storage.treatAsSvg)"],
      ["image validation", "if (storage.validateAsImage)"],
      ["the video poster frame", "if (storage.extractVideoThumbnail)"],
      ["the image worker", "if (storage.queueImageJob)"],
    ]) {
      assert.ok(source.includes(gate), `${what} is not gated on the decision`);
    }
  });
});
