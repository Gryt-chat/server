import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeName, similarity, suggestMatches } from "./match";

describe("matching Discord channels to Gryt ones", () => {
  it("sees through emoji, separators and filler words", () => {
    assert.equal(normalizeName("💬・general-chat"), "general");
    assert.equal(normalizeName("📎 clips"), "clips");
    assert.equal(similarity("💬・general-chat", "General"), 1);
    assert.ok(similarity("lfg", "looking-for-group") < 0.6);
  });

  it("pairs each Discord channel with one Gryt channel of the same kind", () => {
    const m = suggestMatches(
      [
        { id: "d1", name: "💬・general-chat", kind: "text" },
        { id: "d2", name: "general", kind: "text" },
        { id: "d3", name: "announcements", kind: "text" },
        { id: "d4", name: "Squad 1", kind: "voice" },
      ],
      [
        { id: "g1", name: "general", kind: "text" },
        { id: "g2", name: "announcements-here", kind: "text" },
        { id: "g3", name: "Squad 1", kind: "text" },
      ],
    );
    assert.equal(m.size, 2);
    assert.ok(m.get("d1") === "g1" || m.get("d2") === "g1");
    assert.equal(m.get("d3"), "g2");
    assert.equal(m.has("d4"), false);
  });
});
