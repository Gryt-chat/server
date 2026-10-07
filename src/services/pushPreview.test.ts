import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { capabilityTag, PREVIEW_KEY_SHAPE, previewText, sealPreview } from "./pushPreview";

const CAP = `p_${"a".repeat(43)}`;

/** Written from the format, not from the sealing code: what the phone's extension does. */
function open(previewKey: string, capability: string, blob: string, tag = capabilityTag(capability)): unknown {
  const raw = Buffer.from(blob, "base64url");
  assert.equal(raw[0], 1, "version byte");
  const nonce = raw.subarray(1, 13);
  const sealed = raw.subarray(13, raw.length - 16);
  const authTag = raw.subarray(raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(previewKey, "base64url"), nonce);
  decipher.setAAD(Buffer.from(`gryt-push-1|${tag}`));
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(sealed), decipher.final()]).toString("utf8"));
}

describe("sealPreview", () => {
  const key = randomBytes(32).toString("base64url");

  it("opens with the phone's key into title, subtitle and body", () => {
    assert.match(key, PREVIEW_KEY_SHAPE);
    const blob = sealPreview(key, CAP, { title: "Alice", subtitle: "#general · Gryt", body: "hey there" });
    assert.deepEqual(open(key, CAP, blob), { t: "Alice", s: "#general · Gryt", b: "hey there" });
  });

  it("uses the same tag the relay puts on the push", () => {
    assert.equal(capabilityTag(CAP), createHash("sha256").update(CAP).digest("hex").slice(0, 16));
  });

  it("won't open with another key, or as another capability's push", () => {
    const blob = sealPreview(key, CAP, { title: "Alice", body: "hi" });
    assert.throws(() => open(randomBytes(32).toString("base64url"), CAP, blob));
    assert.throws(() => open(key, CAP, blob, capabilityTag(`p_${"b".repeat(43)}`)));
  });

  it("is new ciphertext every time, so two equal messages don't look equal", () => {
    const one = sealPreview(key, CAP, { title: "Alice", body: "hi" });
    const two = sealPreview(key, CAP, { title: "Alice", body: "hi" });
    assert.notEqual(one, two);
  });

  it("stays well under what APNs takes, whatever the message", () => {
    const blob = sealPreview(key, CAP, { title: "x".repeat(500), subtitle: "y".repeat(500), body: "😀".repeat(2000) });
    assert.ok(blob.length < 1500, `${blob.length} characters`);
    const opened = open(key, CAP, blob) as { b: string };
    assert.equal([...opened.b].length, 140, "clipped by character, so no emoji is cut in half");
  });

  it("refuses a key that isn't 32 bytes", () => {
    assert.throws(() => sealPreview(Buffer.alloc(16).toString("base64url"), CAP, { title: "a", body: "b" }));
  });
});

describe("previewText", () => {
  it("is the first line that has anything on it, with mention links shown as their label", () => {
    assert.equal(previewText("\n\nhi [@Carol](mention:u_1), look   here\nsecond line"), "hi @Carol, look here");
  });

  it("says what was sent when there's no text", () => {
    assert.equal(previewText("", 1), "Sent an attachment");
    assert.equal(previewText(null, 3), "Sent 3 attachments");
    assert.equal(previewText("   "), "New message");
  });
});
