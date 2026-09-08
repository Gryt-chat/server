import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AVATAR_MAX_BYTES,
  DEFAULT_EMOJI_MAX_BYTES,
  DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
  DEFAULT_UPLOAD_MAX_BYTES,
} from "./interfaces";

const MB = 1024 * 1024;

/** The numbers almost every server runs on. Pinned rather than merely lowered: a
    default that drifts back up does it quietly, on somebody else's box. */
describe("upload defaults", () => {
  it("are sized for what people send", () => {
    assert.equal(DEFAULT_AVATAR_MAX_BYTES, 8 * MB);
    assert.equal(DEFAULT_UPLOAD_MAX_BYTES, 25 * MB);
    assert.equal(DEFAULT_EMOJI_MAX_BYTES, 2 * MB);
  });

  it("keep an avatar smaller than an attachment, and an emoji smaller again", () => {
    assert.ok(DEFAULT_EMOJI_MAX_BYTES < DEFAULT_AVATAR_MAX_BYTES);
    assert.ok(DEFAULT_AVATAR_MAX_BYTES < DEFAULT_UPLOAD_MAX_BYTES);
  });

  /** Also a bound on memory: that path buffers rather than streams, so this is
      what one request can make the process hold. */
  it("keep the buffered path modest", () => {
    assert.ok(DEFAULT_AVATAR_MAX_BYTES <= 16 * MB, "avatars are held in memory while being re-encoded");
  });

  it("cap how many files one message carries", () => {
    assert.equal(DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE, 10);
    assert.ok(DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE > 0);
  });
});
