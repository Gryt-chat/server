import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicHost } from "./server";

describe("publicHost", () => {
  it("turns EXTERNAL_HOST into the bare host a client saves", () => {
    assert.equal(publicHost("https://beta.sivert.io"), "beta.sivert.io");
    assert.equal(publicHost("http://203.0.113.5:5000/"), "203.0.113.5:5000");
    assert.equal(publicHost("chat.example.com"), "chat.example.com");
    assert.equal(publicHost(""), undefined);
    assert.equal(publicHost(undefined), undefined);
  });
});
