import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEV_CORS_ORIGINS,
  isOriginAllowed,
  originIsHost,
  readAllowedOrigins,
} from "./cors";

const LIST = ["http://127.0.0.1:15738", "https://app.gryt.chat"];

describe("readAllowedOrigins", () => {
  it("adds the dev origins outside production and not in it", () => {
    assert.ok(readAllowedOrigins(undefined, false).includes(DEV_CORS_ORIGINS[0]));
    assert.ok(!readAllowedOrigins(undefined, true).includes(DEV_CORS_ORIGINS[0]));
  });

  it("splits and trims CORS_ORIGIN", () => {
    assert.deepEqual(readAllowedOrigins(" a , b ,, c ", true), ["a", "b", "c"]);
  });
});

describe("originIsHost", () => {
  it("matches the host the request was sent to", () => {
    assert.equal(originIsHost("http://chat.example.com", "chat.example.com"), true);
    assert.equal(originIsHost("https://chat.example.com", "chat.example.com"), true);
  });

  it("keeps the port, so a neighbour on the same machine is not the same origin", () => {
    assert.equal(originIsHost("http://localhost:5001", "localhost:5001"), true);
    assert.equal(originIsHost("http://localhost:5002", "localhost:5001"), false);
    assert.equal(originIsHost("http://localhost", "localhost:5001"), false);
  });

  it("refuses a different host", () => {
    assert.equal(originIsHost("http://evil.example", "chat.example.com"), false);
  });

  it("refuses a suffix that merely looks like the host", () => {
    assert.equal(originIsHost("http://evil-chat.example.com", "chat.example.com"), false);
    assert.equal(originIsHost("http://chat.example.com.evil.test", "chat.example.com"), false);
  });

  it("refuses a non-http scheme", () => {
    assert.equal(originIsHost("file://chat.example.com", "chat.example.com"), false);
    assert.equal(originIsHost("ws://chat.example.com", "chat.example.com"), false);
  });

  it("refuses nonsense rather than throwing", () => {
    assert.equal(originIsHost("not a url", "chat.example.com"), false);
    assert.equal(originIsHost("http://chat.example.com", ""), false);
  });
});

describe("isOriginAllowed", () => {
  it("allows anything on the list", () => {
    assert.equal(isOriginAllowed("https://app.gryt.chat", LIST), true);
  });

  it('allows "null", which is what Electron sends from file://', () => {
    assert.equal(isOriginAllowed("null", LIST), true);
  });

  it("honours a wildcard", () => {
    assert.equal(isOriginAllowed("https://anything.example", ["*"]), true);
  });

  it("allows a native client claiming the host it dialled", () => {
    // React Native's WebSocket sets Origin from the URL it opens, so the phone
    // arrives claiming the server's own address. That is same-origin.
    assert.equal(
      isOriginAllowed("http://chat.example.com", LIST, "chat.example.com"),
      true,
    );
  });

  it("does NOT allow an unlisted origin just because a host was supplied", () => {
    assert.equal(
      isOriginAllowed("https://evil.example", LIST, "chat.example.com"),
      false,
    );
  });

  it("does NOT allow a same-host origin when no host is known", () => {
    // Without the Host header there is nothing to compare against, and
    // guessing would be the hole this is careful not to open.
    assert.equal(isOriginAllowed("http://chat.example.com", LIST), false);
  });

  it("still refuses an unlisted origin with no host", () => {
    assert.equal(isOriginAllowed("https://evil.example", LIST), false);
  });
});
