import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import { getSqliteDb, initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole, updateServerConfig } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { initStorage } from "../storage";
import { apiErrorHandler } from "../utils/httpErrors";
import { generateAccessToken } from "../utils/jwt";

/* GRYT-1802: the operator's upload ceiling, refused while it streams, and the temp file multer
   writes is gone afterwards whichever way the request ended. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = require("../storage") as typeof import("../storage");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { uploadsRouter } = require("./uploads") as typeof import("./uploads");

let dir: string;
let temp: string;
let server: Server;
let base = "";
let auth: Record<string, string> = {};
const puts: { sourcePath?: string; buffered: boolean }[] = [];

const files = () => (getSqliteDb().prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;

async function send(bytes: number) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes).fill(0x61)], { type: "text/plain" }), "notes.txt");
  const res = await fetch(`${base}/api/uploads`, { method: "POST", headers: auth, body: form });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-upload-limit-"));
  // multer's disk storage asks os.tmpdir() per file, so this is where its temp files land.
  temp = mkdtempSync(join(tmpdir(), "gryt-upload-temp-"));
  process.env.TMPDIR = temp;
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt-test";
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();

  const put = storage.putObject;
  storage.putObject = (params) => {
    puts.push({ sourcePath: params.sourcePath, buffered: params.body !== undefined });
    return put(params);
  };

  const user = await upsertUser("acct-upload-limit", "uma");
  await setServerRole(user.server_user_id, "member");

  const app = express();
  app.use("/api/uploads", uploadsRouter);
  app.use(apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
  const token = generateAccessToken({ serverUserId: user.server_user_id, grytUserId: "acct-upload-limit", nickname: "uma", serverHost: host, tokenVersion: 0 });
  auth = { Authorization: `Bearer ${token}` };
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

describe("the upload size limit", () => {
  it("refuses a file over upload_max_bytes with a 413 and stores nothing", async () => {
    await updateServerConfig({ uploadMaxBytes: 1000 });
    const before = files();
    puts.length = 0;
    const res = await send(2000);
    assert.equal(res.status, 413, JSON.stringify(res.body));
    assert.equal(res.body.error, "file_too_large");
    assert.equal(files(), before);
    assert.deepEqual(puts, []);
    assert.deepEqual(readdirSync(temp), [], "the refused temp file is gone");
  });

  it("takes a file under the limit, hands storage a path rather than a buffer, and drops the temp file", async () => {
    await updateServerConfig({ uploadMaxBytes: 1000 });
    puts.length = 0;
    const res = await send(500);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(puts.length, 1);
    assert.equal(typeof puts[0].sourcePath, "string");
    assert.equal(puts[0].buffered, false);
    assert.ok(puts[0].sourcePath!.startsWith(temp), puts[0].sourcePath);
    assert.deepEqual(readdirSync(temp), [], "the temp file is gone after success");
  });

  it("treats a limit of 0 as unlimited", async () => {
    await updateServerConfig({ uploadMaxBytes: 0 });
    const res = await send(2000);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(readdirSync(temp), []);
  });
});
