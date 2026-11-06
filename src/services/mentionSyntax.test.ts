import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { canonicalizeMentions, mentionsAsText, mentionTarget } from "./mentionSyntax";

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

describe("mention links as words, for previews and search (GRYT-2025)", () => {
  const nickname = async (id: string) => ({ user_leo: "Leo", user_ada: "Ada" } as Record<string, string>)[id] ?? null;

  it("names users by their current nickname, even with an empty or stale label", async () => {
    assert.equal(await mentionsAsText("[](mention:user_leo) look at this", nickname), "@Leo look at this");
    assert.equal(await mentionsAsText("thanks [@OldName](mention:user_ada)!", nickname), "thanks @Ada!");
    assert.equal(await mentionsAsText("[@Gone](mention:user_gone) and [](mention:user_x)", nickname), "@Gone and @someone");
  });

  it("turns mass, role and channel links into words", async () => {
    assert.equal(
      await mentionsAsText("[@everyone](mention:everyone) [@here](mention:here) [@Mods](role:mods) see [#channel](channel:abc)", nickname),
      "@everyone @here @Mods see #channel",
    );
  });

  it("leaves code and ordinary links alone", async () => {
    assert.equal(await mentionsAsText("`[](mention:user_leo)` and [docs](https://gryt.chat)", nickname), "`[](mention:user_leo)` and [docs](https://gryt.chat)");
  });

  it("keeps the name and drops the markup where a snippet cut through a link", async () => {
    assert.equal(await mentionsAsText("eo](mention:user_leo) said hi", nickname), "eo said hi");
    assert.equal(await mentionsAsText("said hi to [@Le", nickname), "said hi to [@Le");
    assert.equal(await mentionsAsText("said hi to [@Leo](mention:user_l", nickname), "said hi to @Leo");
  });
});
