import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClientKind } from "./clientKind";

const ELECTRON_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "gryt-chat/1.7.0 Chrome/128.0.6613.186 Electron/32.2.1 Safari/537.36";
const ELECTRON_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "gryt-chat/1.7.0 Chrome/128.0.6613.186 Electron/32.2.1 Safari/537.36";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/128.0.0.0 Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const MOBILE_SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/17.5 Mobile/15E148 Safari/604.1";
const OKHTTP_ANDROID = "okhttp/4.12.0";
const CFNETWORK_IOS = "Gryt/1 CFNetwork/1494.0.7 Darwin/23.4.0";

test("classifyClientKind", async (t) => {
  await t.test("Electron desktop, macOS", () => {
    assert.equal(classifyClientKind(ELECTRON_MAC), "desktop");
  });

  await t.test("Electron desktop, Windows", () => {
    assert.equal(classifyClientKind(ELECTRON_WINDOWS), "desktop");
  });

  await t.test("Chrome on Windows is web, not desktop", () => {
    assert.equal(classifyClientKind(CHROME_WINDOWS), "web");
  });

  await t.test("Firefox on Linux is web", () => {
    assert.equal(classifyClientKind(FIREFOX_LINUX), "web");
  });

  await t.test("mobile Safari is web, not ios", () => {
    assert.equal(classifyClientKind(MOBILE_SAFARI_IOS), "web");
  });

  await t.test("bare OkHttp agent is android", () => {
    assert.equal(classifyClientKind(OKHTTP_ANDROID), "android");
  });

  await t.test("CFNetwork agent is ios", () => {
    assert.equal(classifyClientKind(CFNETWORK_IOS), "ios");
  });

  await t.test("missing agent is other", () => {
    assert.equal(classifyClientKind(undefined), "other");
    assert.equal(classifyClientKind(null), "other");
    assert.equal(classifyClientKind(""), "other");
  });

  await t.test("unrecognised agent is other", () => {
    assert.equal(classifyClientKind("curl/8.4.0"), "other");
  });
});
