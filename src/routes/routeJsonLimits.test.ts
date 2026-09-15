import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";
import sharp from "sharp";

import { initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { initStorage } from "../storage";
import { apiErrorHandler, jsonBodyExcept } from "../utils/httpErrors";
import { generateAccessToken } from "../utils/jwt";
import { emojisRouter } from "./emojis";
import { OWN_JSON_PARSERS, parsesOwnJson } from "./ownJsonParsers";
import { webhooksRouter } from "./webhooks";

/** GRYT-1200: the app-wide 2 MB parser read these bodies first, so the routes' own 100 KB limit never applied. */

const LIMIT = 100 * 1024;

let dir: string;
let server: Server;
let base = "";
let token = "";

async function call(method: string, path: string, body: string | FormData) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (typeof body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Trailing whitespace is valid JSON, so the body is still a real request at exactly `bytes` long.
function sized(value: unknown, bytes: number): string {
  const json = JSON.stringify(value);
  assert.ok(json.length <= bytes);
  return json + " ".repeat(bytes - json.length);
}

async function noisyPng(side: number): Promise<Buffer> {
  return sharp({ create: { width: side, height: side, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } })
    .png()
    .toBuffer();
}

function pngForm(png: Buffer, name: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), `${name}.png`);
  form.append("name", name);
  return form;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-routejsonlimits-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt-test";
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();

  const user = await upsertUser("acct-owner", "owner");
  await setServerRole(user.server_user_id, "owner");

  const app = express();
  app.use(jsonBodyExcept(parsesOwnJson, { limit: "2mb" }));
  app.use("/api/emojis", emojisRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use(apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
  token = generateAccessToken({ serverUserId: user.server_user_id, grytUserId: "acct-owner", nickname: "owner", serverHost: host, tokenVersion: 0 });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

function assertTooLarge(res: { status: number; body: Record<string, unknown> }) {
  assert.equal(res.status, 413, JSON.stringify(res.body));
  assert.equal(res.body.error, "body_too_large");
  assert.match(String(res.body.message), /100 KB/);
}

describe("webhook management bodies", () => {
  let webhookId = "";

  it("creates a webhook from a body of exactly 100 KB", async () => {
    const res = await call("POST", "/api/webhooks", sized({ channel_id: "general", display_name: "CI" }, LIMIT));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    webhookId = res.body.webhook_id as string;
  });

  it("refuses a create body one byte over 100 KB", async () => {
    assertTooLarge(await call("POST", "/api/webhooks", sized({ channel_id: "general" }, LIMIT + 1)));
  });

  it("updates a webhook from a body of exactly 100 KB", async () => {
    const res = await call("PATCH", `/api/webhooks/${webhookId}`, sized({ display_name: "Renamed" }, LIMIT));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.display_name, "Renamed");
  });

  it("refuses an update body one byte over 100 KB", async () => {
    assertTooLarge(await call("PATCH", `/api/webhooks/${webhookId}`, sized({ display_name: "x" }, LIMIT + 1)));
  });
});

describe("emoji bodies", () => {
  it("still takes an image upload well over 100 KB", async () => {
    const png = await noisyPng(400);
    assert.ok(png.length > 4 * LIMIT, `test image is only ${png.length} bytes`);
    const res = await call("POST", "/api/emojis", pngForm(png, "big_one"));
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it("still refuses an image upload over emoji_max_bytes", async () => {
    const png = await noisyPng(1000);
    assert.ok(png.length > 2 * 1024 * 1024, `test image is only ${png.length} bytes`);
    const res = await call("POST", "/api/emojis", pngForm(png, "too_big"));
    assert.equal(res.status, 413, JSON.stringify(res.body));
    assert.equal(res.body.error, "file_too_large");
  });

  it("renames an emoji from a body of exactly 100 KB", async () => {
    const res = await call("PATCH", "/api/emojis/big_one", sized({ name: "big_two" }, LIMIT));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, "big_two");
  });

  it("refuses a rename body one byte over 100 KB", async () => {
    assertTooLarge(await call("PATCH", "/api/emojis/big_two", sized({ name: "big_three" }, LIMIT + 1)));
  });

  // Invalid ids are refused per emote before any CDN fetch, so this reaches the route without the network.
  const emotes = [{ id: "nope", code: "x", imageType: "png", name: "bttv_one" }];

  it("reads a BTTV import body of exactly 100 KB", async () => {
    const res = await call("POST", "/api/emojis/bttv/import", sized({ emotes }, LIMIT));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.deepEqual((res.body.results as Array<{ error: string }>).map((r) => r.error), ["invalid_bttv_id"]);
  });

  it("refuses a BTTV import body one byte over 100 KB", async () => {
    assertTooLarge(await call("POST", "/api/emojis/bttv/import", sized({ emotes }, LIMIT + 1)));
  });
});

describe("parsesOwnJson", () => {
  it("matches trailing slashes and any case, the way Express routes do", () => {
    for (const path of ["/api/webhooks/", "/API/Webhooks", "/api/emojis/BTTV/import/", "/api/webhooks/a/b/"]) {
      assert.equal(parsesOwnJson({ method: "POST", path }), true, path);
    }
    assert.equal(parsesOwnJson({ method: "PATCH", path: "/api/Emojis/party/" }), true);
  });

  it("leaves other methods and paths to the app-wide parser", () => {
    assert.equal(parsesOwnJson({ method: "POST", path: "/api/emojis" }), false);
    assert.equal(parsesOwnJson({ method: "POST", path: "/api/emojis/stage" }), false);
    assert.equal(parsesOwnJson({ method: "PATCH", path: "/api/webhooks" }), false);
    assert.equal(parsesOwnJson({ method: "PATCH", path: "/api/emojis/a/b" }), false);
    assert.equal(parsesOwnJson({ method: "POST", path: "/api/webhooks/a/b/c" }), false);
    assert.equal(parsesOwnJson({ method: "POST", path: "/api/messages/general" }), false);
  });
});

describe("the skip list", () => {
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name?: string }> } };
  const parsing = (router: unknown, mount: string) =>
    ((router as { stack: RouteLayer[] }).stack ?? [])
      .filter((l) => l.route?.stack.some((h) => h.name === "jsonParser"))
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${`${mount}${l.route!.path}`.replace(/\/$/, "")}`));

  it("names exactly the routes that bring their own JSON parser", () => {
    const actual = [...parsing(emojisRouter, "/api/emojis"), ...parsing(webhooksRouter, "/api/webhooks")].sort();
    assert.deepEqual(actual, OWN_JSON_PARSERS.map((r) => `${r.method} ${r.path}`).sort());
  });

  it("covers every router file that calls express.json", () => {
    const dirPath = __dirname;
    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => readFileSync(join(dirPath, f), "utf8").includes("express.json("))
      .sort();
    // management.ts is on its own port, where no app-wide parser runs.
    assert.deepEqual(files, ["emojiBttvImport.ts", "emojis.ts", "management.ts", "webhooks.ts"]);
  });
});
