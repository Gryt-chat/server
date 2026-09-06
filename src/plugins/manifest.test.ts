import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAPABILITY_LABELS,
  PLUGIN_CAPABILITIES,
  declaredCapabilities,
  readManifest,
} from "./manifest";

/**
 * Reading somebody else's manifest.json (GRYT-933).
 *
 * This runs once at startup and everything after it trusts the result, so the
 * cases that matter are the ones where a manifest is wrong rather than the one
 * where it is right. A plugin is arbitrary code either way — what is being
 * defended here is that the operator gets told which line to fix, and that a
 * declaration cannot be written to mean more than it says.
 */

const valid = {
  id: "automod",
  name: "Automod",
  version: "1.0.0",
  main: "index.js",
};

describe("the catalogue", () => {
  it("says what every capability means", () => {
    for (const capability of PLUGIN_CAPABILITIES) {
      assert.ok(
        CAPABILITY_LABELS[capability],
        `${capability} has no label, so nobody would know what they were agreeing to`,
      );
    }
  });
});

describe("an ordinary manifest", () => {
  it("comes through", () => {
    const result = readManifest({ ...valid, description: " Bans spam ", author: "you" });
    assert.ok(result.ok);
    assert.equal(result.manifest.id, "automod");
    assert.equal(result.manifest.description, "Bans spam", "not trimmed");
    assert.deepEqual(result.manifest.capabilities, []);
  });

  it("leaves the optional fields undefined rather than empty", () => {
    const result = readManifest(valid);
    assert.ok(result.ok);
    assert.equal(result.manifest.description, undefined);
    assert.equal(result.manifest.author, undefined);
  });

  /* A blank one is absent, not present-and-empty. The required fields cannot
     tell the difference — "" is falsy and refused either way — so the optional
     ones are the only place this is visible. */
  it("treats a blank optional field as absent", () => {
    const result = readManifest({ ...valid, description: "   ", author: "" });
    assert.ok(result.ok);
    assert.equal(result.manifest.description, undefined);
    assert.equal(result.manifest.author, undefined);
  });
});

describe("a manifest that is not one", () => {
  for (const junk of [null, undefined, 42, "automod", [], [valid]]) {
    it(`is refused for ${JSON.stringify(junk) ?? "undefined"}`, () => {
      const result = readManifest(junk);
      assert.equal(result.ok, false);
    });
  }
});

/*
 * Each of these names the field. An operator looking at this is reading
 * somebody else's folder, and "invalid manifest" sends them to read the whole
 * thing rather than the line that is wrong.
 */
describe("a missing field", () => {
  for (const field of ["id", "name", "version", "main"] as const) {
    it(`says which one, for ${field}`, () => {
      const without = { ...valid };
      delete (without as Record<string, unknown>)[field];
      const result = readManifest(without);
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && result.reason.includes(field), result.ok === false ? result.reason : "");
    });

    it(`treats blank as missing, for ${field}`, () => {
      const result = readManifest({ ...valid, [field]: "   " });
      assert.equal(result.ok, false);
    });

    it(`treats a non-string as missing, for ${field}`, () => {
      const result = readManifest({ ...valid, [field]: 7 });
      assert.equal(result.ok, false);
    });
  }
});

/*
 * The id becomes a path segment — the storage namespace and the config key —
 * so it is kept to something that cannot climb out of one here, rather than at
 * each place it is joined onto a path.
 */
describe("an id that would not survive being a folder name", () => {
  for (const id of ["../escape", "a/b", "a\\b", ".hidden", "Automod", "", "x".repeat(65), "-lead"]) {
    it(`is refused: ${JSON.stringify(id)}`, () => {
      assert.equal(readManifest({ ...valid, id }).ok, false);
    });
  }

  for (const id of ["automod", "auto-mod", "auto_mod", "auto.mod", "a", "a1", "x".repeat(64)]) {
    it(`is allowed: ${JSON.stringify(id)}`, () => {
      assert.equal(readManifest({ ...valid, id }).ok, true);
    });
  }
});

describe("a main that points outside the folder", () => {
  for (const main of ["../../etc/passwd", "/etc/passwd", "\\windows\\system32", "a/../../b"]) {
    it(`is refused: ${JSON.stringify(main)}`, () => {
      const result = readManifest({ ...valid, main });
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && result.reason.includes("main"));
    });
  }

  it("allows a file in a subfolder", () => {
    assert.equal(readManifest({ ...valid, main: "dist/index.js" }).ok, true);
  });
});

describe("a version that is not short and printable", () => {
  for (const version of ["1.0.0", "0.1", "2026-09-06", "1.0.0-beta.1", "v3"]) {
    it(`is allowed: ${version}`, () => {
      assert.equal(readManifest({ ...valid, version }).ok, true);
    });
  }

  for (const version of ["x".repeat(33), "1.0 (stable)", "one point oh"]) {
    it(`is refused: ${JSON.stringify(version)}`, () => {
      assert.equal(readManifest({ ...valid, version }).ok, false);
    });
  }
});

describe("what a manifest asked for", () => {
  it("keeps what it recognises", () => {
    assert.deepEqual(declaredCapabilities(["members:read"]), ["members:read"]);
  });

  /* Dropped rather than refused, so a plugin written against a newer Gryt still
     loads here and simply does not get the new part. */
  it("ignores a name this build has never heard of", () => {
    assert.deepEqual(declaredCapabilities(["members:read", "read-your-email"]), ["members:read"]);
    assert.deepEqual(declaredCapabilities(["read-your-email"]), []);
  });

  it("is nothing at all for anything that is not a list of strings", () => {
    for (const junk of [undefined, null, "members:read", 42, {}, [null], [{}], [["members:read"]]]) {
      assert.deepEqual(declaredCapabilities(junk), [], `expected nothing from ${JSON.stringify(junk)}`);
    }
  });

  it("cannot be padded with repeats", () => {
    assert.deepEqual(declaredCapabilities(["members:read", "members:read"]), ["members:read"]);
  });

  /* Written against the catalogue rather than a fixed pair, so it keeps meaning
     something as capabilities are added. Two manifests asking for the same
     things must produce the same list whichever order they wrote them in. */
  it("comes back in catalogue order", () => {
    assert.deepEqual(
      declaredCapabilities([...PLUGIN_CAPABILITIES].reverse()),
      [...PLUGIN_CAPABILITIES],
    );
  });

  it("reaches the manifest normalised, not as written", () => {
    const result = readManifest({
      ...valid,
      capabilities: ["members:read", "messages:read", "members:read", "nonsense"],
    });
    assert.ok(result.ok);
    assert.deepEqual(
      result.manifest.capabilities,
      PLUGIN_CAPABILITIES.filter((c) => c === "messages:read" || c === "members:read"),
    );
  });
});
