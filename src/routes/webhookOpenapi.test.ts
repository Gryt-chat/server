import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { webhookOpenApiJson } from "./webhookOpenapi";

describe("openapi/webhooks.json", () => {
  it("matches the zod schemas the routes parse with", () => {
    const committed = readFileSync(join(__dirname, "..", "..", "openapi", "webhooks.json"), "utf8");
    assert.equal(
      committed,
      webhookOpenApiJson(),
      "openapi/webhooks.json is out of date. Run `yarn openapi:webhooks` and commit the result.",
    );
  });
});
