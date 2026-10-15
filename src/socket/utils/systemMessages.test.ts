import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatAddedMessage } from "./systemMessages";

describe("who added whom to a group (GRYT-1753)", () => {
  it("names both as mentions, so each client draws the names it knows them by", () => {
    assert.equal(
      formatAddedMessage({ nickname: "Al", serverUserId: "u-al" }, { nickname: "Sivert", serverUserId: "u-sivert" }),
      "[@Al](mention:u-al) added [@Sivert](mention:u-sivert)",
    );
  });
});
