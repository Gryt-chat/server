import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";
import sharp from "sharp";

import { initSqlite } from "../db/sqlite/connection";
import { getFile } from "../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../db/sqlite/users";
import { unreferencedAmong } from "../jobs/mediaSweep";
import { initStorage } from "../storage";
import { generateAccessToken } from "../utils/jwt";
import { uploadsRouter } from "./uploads";
import { webhooksRouter } from "./webhooks";

/** The sweep kept files that messages, user avatars and group icons point at,
    but not webhook avatars, so those went 30 minutes after upload (GRYT-1183). */

let dir: string;
let server: Server;
let base = "";
let host = "";
let token = "";
let serverUserId = "";

async function call(path: string, init: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function uploadPicture(): Promise<string> {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 230, g: 90, b: 30 } } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "hook.png");
  const res = await call("/api/uploads", { method: "POST", body: form });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // The settings tab read `file_id`, which this route has never sent.
  assert.equal(res.body.file_id, undefined);
  assert.ok(res.body.fileId, "no fileId in the reply");
  return res.body.fileId as string;
}

async function createHook(): Promise<string> {
  const res = await call("/api/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: "general", display_name: "CI" }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.webhook_id as string;
}

const setAvatar = (webhookId: string, fileId: string | null) =>
  call(`/api/webhooks/${webhookId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_file_id: fileId }),
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-webhookavatar-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt-test";
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();

  const grytUserId = "acct-owner";
  const user = await upsertUser(grytUserId, "owner");
  await setServerRole(user.server_user_id, "owner");
  serverUserId = user.server_user_id;

  const app = express();
  app.use("/api/uploads", uploadsRouter);
  app.use("/api/webhooks", webhooksRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
  token = generateAccessToken({ serverUserId, grytUserId, nickname: "owner", serverHost: host, tokenVersion: 0 });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

describe("a webhook's avatar", () => {
  it("is kept by the media sweep once a webhook wears it", async () => {
    const fileId = await uploadPicture();
    const webhookId = await createHook();

    // Nothing points at it yet, so a picture chosen and then abandoned is swept.
    assert.deepEqual(await unreferencedAmong([fileId]), [fileId]);

    const res = await setAvatar(webhookId, fileId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.avatar_file_id, fileId);
    assert.deepEqual(await unreferencedAmong([fileId]), []);
    assert.ok(await getFile(fileId));
  });

  it("goes back to the sweep once the webhook drops it", async () => {
    const fileId = await uploadPicture();
    const webhookId = await createHook();
    await setAvatar(webhookId, fileId);

    await setAvatar(webhookId, null);
    assert.deepEqual(await unreferencedAmong([fileId]), [fileId]);
  });

  it("leaves the uploader's own avatar alone", async () => {
    const fileId = await uploadPicture();
    await setAvatar(await createHook(), fileId);
    assert.equal((await getUserByServerId(serverUserId))?.avatar_file_id ?? null, null);
  });
});
