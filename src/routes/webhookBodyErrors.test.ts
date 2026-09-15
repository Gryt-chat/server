import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import { initSqlite } from "../db/sqlite/connection";
import { apiErrorHandler, bodyParserRefusal, jsonBodyExcept } from "../utils/httpErrors";
import { messagesRouter } from "./messages";
import { parsesOwnJson } from "./ownJsonParsers";
import { webhooksRouter } from "./webhooks";

/** GRYT-1198: a body the parser refuses is a 400 or a 413, never a 500. Wired the way index.ts wires it. */

let dir: string;
let server: Server;
let base = "";

async function post(path: string, body: string) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const padded = (bytes: number) => JSON.stringify({ text: "x", pad: "a".repeat(bytes) });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-bodyerrors-"));
  process.env.DATA_DIR = dir;
  await initSqlite();

  const app = express();
  app.use(jsonBodyExcept(parsesOwnJson, { limit: "2mb" }));
  app.use("/api/messages", messagesRouter);
  app.use("/api/webhooks", webhooksRouter);
  app.use(apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("body parser refusals", () => {
  it("answers malformed JSON to a webhook with 400 invalid_json", async () => {
    const res = await post("/api/webhooks/wh1/tok", "{\"text\": ");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_json");
    assert.equal(typeof res.body.message, "string");
  });

  it("answers a webhook body over 256 KB with 413, well under the app-wide 2 MB", async () => {
    const res = await post("/api/webhooks/wh1/tok", padded(300 * 1024));
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "body_too_large");
    assert.match(String(res.body.message), /256 KB/);
  });

  it("still lets a webhook body under 256 KB through to the route", async () => {
    const res = await post("/api/webhooks/wh1/tok", padded(200 * 1024));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "not_found");
  });

  it("answers malformed JSON elsewhere with 400 invalid_json", async () => {
    const res = await post("/api/messages/general", "not json");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_json");
  });

  it("answers a body over 2 MB elsewhere with 413", async () => {
    const res = await post("/api/messages/general", padded(2.5 * 1024 * 1024));
    assert.equal(res.status, 413);
    assert.equal(res.body.error, "body_too_large");
    assert.match(String(res.body.message), /2048 KB/);
  });
});

describe("bodyParserRefusal", () => {
  it("leaves errors that aren't body-parser's to the 500 path", () => {
    assert.equal(bodyParserRefusal(new Error("boom")), null);
    assert.equal(bodyParserRefusal(Object.assign(new Error("x"), { type: "stream.encoding.set", status: 500, expose: false })), null);
  });

  it("passes other client errors through with their own status", () => {
    const err = Object.assign(new Error("unsupported charset \"KOI8\""), { type: "charset.unsupported", status: 415, expose: true });
    assert.deepEqual(bodyParserRefusal(err), { status: 415, body: { error: "invalid_body", message: "unsupported charset \"KOI8\"" } });
  });
});
