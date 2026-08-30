import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { isSealedUpload, storageForUpload } from "./uploadStorage";

/**
 * How an upload is stored, and what a sealed one changes (GRYT-761).
 *
 * The route this came out of cannot be loaded here — express, multer, sharp,
 * ffmpeg and object storage — so the decision moved out to be checked, which is
 * the only reason it is a separate file.
 *
 * The case that matters is not "is it encrypted". It is that a sealed upload
 * skips validation, and skipping validation while keeping the client's content
 * type would store ciphertext labelled `image/svg+xml` under that type and
 * serve it inline from the API's own origin. That is the stored-XSS shape the
 * SVG sanitiser exists to prevent, reached by setting a form field, and nothing
 * about the file would look wrong.
 */

const base = { fileId: "abc", mimetype: "image/png", originalName: "cat.png" };

describe("isSealedUpload", () => {
  it("is exactly \"1\"", () => {
    assert.equal(isSealedUpload({ sealed: "1" }), true);
  });

  it("is false for everything else a form field can be", () => {
    // A flag, not a guess: ciphertext is indistinguishable from noise, so the
    // server cannot work this out for itself and must not try. Anything it does
    // not recognise has to mean the safe answer, which is the validated path.
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
    // Every one of these claims is the client's, and a sealed upload is not
    // validated — so none of them may survive into what the download route
    // serves. `application/octet-stream` is outside `isInlineSafe`, which is
    // what makes the download an attachment with nosniff and a sandbox CSP.
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
    // The real one is inside the sealed message with the key. Recording it here
    // puts back the thing the encryption is for — a filename says a great deal
    // about a file, and it goes out in every message that names the attachment.
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
    // The worker hands its input to sharp and sharp renders SVG through
    // librsvg. Storing the vector is what keeps a memory-unsafe parser away
    // from a stranger's bytes. This used to be true by control flow — the route
    // returned before reaching the queue — so moving the decision out here is
    // where it stops being an accident.
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
  /**
   * `uploads.ts` cannot be imported here — express, multer, sharp, ffmpeg and
   * object storage — so this reads it. A decision that is right in this file
   * and not asked for over there is the same bug as getting it wrong, and it
   * would pass every assertion above.
   */
  // `__dirname` rather than `import.meta.url`: this suite runs under
  // `ts-node/register` in CommonJS, where the meta-property does not compile.
  const file = readFileSync(join(__dirname, "uploads.ts"), "utf8");

  /**
   * The attachment route only — the first `uploadsRouter.post`, up to the
   * avatar one.
   *
   * The avatar route has two `insertFile` calls of its own and neither is
   * reachable with a sealed upload: an avatar is a picture of you that the
   * server resizes, and encrypting it would mean nobody could see it. Scoping
   * matters both ways round — a check over the whole file would fail on the
   * avatar rows for no reason, and one that read the whole file loosely would
   * pass because the avatar route happens to satisfy it.
   */
  const routeStart = file.indexOf("uploadsRouter.post(");
  const routeEnd = file.indexOf("uploadsRouter.post(", routeStart + 1);
  const source = file.slice(routeStart, routeEnd);

  it("asks for the decision rather than working it out again", () => {
    assert.match(source, /storageForUpload\(\{/, "the route no longer calls storageForUpload");
    assert.match(source, /sealed: isSealedUpload\(req\.body\)/, "the flag is not read off the request");
  });

  it("stores what the decision said, not what the client sent", () => {
    // The line that matters. `file.mimetype` reaching the `files` row is the
    // stored-XSS shape: ciphertext labelled image/svg+xml, served back inline
    // from the API's own origin.
    //
    // Every `insertFile`, not the first one — the route has two, and it was the
    // second that needed changing, so a check that stopped at one would have
    // passed while the other still wrote the client's filename.
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
