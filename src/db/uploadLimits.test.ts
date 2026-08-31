import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AVATAR_MAX_BYTES,
  DEFAULT_EMOJI_MAX_BYTES,
  DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
  DEFAULT_UPLOAD_MAX_BYTES,
} from "./interfaces";

const MB = 1024 * 1024;

/**
 * These are the numbers almost every server runs on, because a default is what
 * you get for never opening the settings. All three were 100MB, which is
 * storage nobody asked for on a box that may have no backups.
 *
 * Pinned rather than merely lowered: a default that drifts back up does it
 * quietly, and the server it costs is somebody else's.
 */
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

  /**
   * The avatar limit doubles as a bound on memory: that path buffers the file
   * rather than streaming it, so whatever this says is what one request can
   * make the process hold.
   */
  it("keep the buffered path modest", () => {
    assert.ok(DEFAULT_AVATAR_MAX_BYTES <= 16 * MB, "avatars are held in memory while being re-encoded");
  });

  it("cap how many files one message carries", () => {
    assert.equal(DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE, 10);
    assert.ok(DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE > 0);
  });
});
