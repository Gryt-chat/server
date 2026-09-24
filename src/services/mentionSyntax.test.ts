import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { canonicalizeMentions, mentionTarget } from "./mentionSyntax";

interface Vectors {
  targets: { href: string; target: unknown }[];
  canonical: {
    text: string;
    rights: {
      everyone: boolean;
      roles?: Record<string, { name: string; mentionable: boolean }>;
      channels?: { id: string; name: string }[];
    };
    stored: string;
    everyone: boolean;
    here: boolean;
    roleIds: string[];
  }[];
}

const vectors = JSON.parse(readFileSync(join(__dirname, "mention-vectors.json"), "utf8")) as Vectors;

describe("mention links, as the clients read them", () => {
  for (const v of vectors.targets) {
    it(v.href || "(empty)", () => assert.deepEqual(mentionTarget(v.href), v.target));
  }
});

describe("what the server stores", () => {
  for (const v of vectors.canonical) {
    it(JSON.stringify(v.text), () => {
      const out = canonicalizeMentions(v.text, {
        everyone: v.rights.everyone,
        roles: new Map(Object.entries(v.rights.roles ?? {})),
        channels: v.rights.channels ?? [],
      });
      assert.equal(out.text, v.stored);
      assert.equal(out.everyone, v.everyone);
      assert.equal(out.here, v.here);
      assert.deepEqual(out.roleIds, v.roleIds);
    });
  }

  it("leaves a role link out of the nickname scan", () => {
    const out = canonicalizeMentions("[@Ada](role:ada) and [@Ada](mention:user_1)", {
      everyone: true,
      roles: new Map([["ada", { name: "Ada", mentionable: false }]]),
      channels: [],
    });
    assert.equal(out.forNicknames.includes("(role:ada)"), false);
    assert.equal(out.forNicknames.includes("[@Ada](mention:user_1)"), true);
  });
});
