import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";
import sharp from "sharp";

import { AVATAR_MAX_PX, AVATAR_THUMB_PX } from "../constants/media";
import { initSqlite } from "../db/sqlite/connection";
import { getAllFileRecords, getFile, getFileOwnership, listMessages } from "../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../db/sqlite/users";
import { unreferencedAmong } from "../jobs/mediaSweep";
import { fileReadVerdict } from "../services/fileAccess";
import { realMediaDeps } from "../services/webhookMedia";
import { getObject, initStorage } from "../storage";
import { generateAccessToken } from "../utils/jwt";
import { uploadsRouter } from "./uploads";
import { setWebhookMediaDepsForTests, webhooksRouter } from "./webhooks";

/** The sweep deleted webhook avatars 30 minutes after upload (GRYT-1183), and
    they were stored at whatever size they were sent (GRYT-1185). */

interface Member { serverUserId: string; grytUserId: string; nickname: string }

let dir: string;
let server: Server;
let base = "";
let host = "";
let owner: Member;
let big: Buffer;

async function member(nickname: string, role: "owner" | "member"): Promise<Member> {
  const grytUserId = `acct-${nickname}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, role);
  return { serverUserId: user.server_user_id, grytUserId, nickname };
}

async function call(path: string, init: RequestInit, who: Member = owner) {
  const token = generateAccessToken({ ...who, serverHost: host, tokenVersion: 0 });
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function uploadAvatar(picture: Buffer, who: Member = owner, type = "image/png", name = "hook.png") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(picture)], { type }), name);
  return call("/api/uploads/webhook-avatar", { method: "POST", body: form }, who);
}

async function uploadPicture(): Promise<string> {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 230, g: 90, b: 30 } } })
    .png()
    .toBuffer();
  const res = await uploadAvatar(png);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // The settings tab once read `file_id`, which no upload route sends.
  assert.equal(res.body.file_id, undefined);
  assert.ok(res.body.fileId, "no fileId in the reply");
  return res.body.fileId as string;
}

async function createHook(channel = "general"): Promise<{ id: string; token: string }> {
  const res = await call("/api/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channel, display_name: "CI" }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.webhook_id as string, token: res.body.token as string };
}

const setAvatar = (webhookId: string, fileId: string | null) =>
  call(`/api/webhooks/${webhookId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_file_id: fileId }),
  });

/** The dimensions of what storage actually holds, rather than what the row says. */
async function storedSize(key: string): Promise<[number | undefined, number | undefined]> {
  const obj = await getObject({ bucket: "gryt-test", key });
  const chunks: Buffer[] = [];
  for await (const chunk of obj.Body as Readable) chunks.push(chunk as Buffer);
  const meta = await sharp(Buffer.concat(chunks)).metadata();
  return [meta.width, meta.height];
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-webhookavatar-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt-test";
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();
  big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 40, g: 90, b: 200 } } })
    .png()
    .toBuffer();

  owner = await member("owner", "owner");

  const app = express();
  app.use("/api/uploads", uploadsRouter);
  app.use("/api/webhooks", webhooksRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
  setWebhookMediaDepsForTests({
    fetchBytes: async () => ({ ok: true, bytes: big }),
    storeImage: realMediaDeps.storeImage,
    storeAvatar: realMediaDeps.storeAvatar,
  });
});

after(async () => {
  setWebhookMediaDepsForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

describe("a webhook's avatar", () => {
  it("is kept by the media sweep once a webhook wears it", async () => {
    const fileId = await uploadPicture();
    const webhook = await createHook();

    // Nothing points at it yet, so a picture chosen and then abandoned is swept.
    assert.deepEqual(await unreferencedAmong([fileId]), [fileId]);

    const res = await setAvatar(webhook.id, fileId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.avatar_file_id, fileId);
    assert.deepEqual(await unreferencedAmong([fileId]), []);
    assert.ok(await getFile(fileId));
  });

  it("goes back to the sweep once the webhook drops it", async () => {
    const fileId = await uploadPicture();
    const webhook = await createHook();
    await setAvatar(webhook.id, fileId);

    await setAvatar(webhook.id, null);
    assert.deepEqual(await unreferencedAmong([fileId]), [fileId]);
  });

  it("leaves the uploader's own avatar alone", async () => {
    const fileId = await uploadPicture();
    await setAvatar((await createHook()).id, fileId);
    assert.equal((await getUserByServerId(owner.serverUserId))?.avatar_file_id ?? null, null);
  });
});

describe("POST /api/uploads/webhook-avatar", () => {
  it("stores a big picture at the avatar size, with a thumbnail", async () => {
    const res = await uploadAvatar(big);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.avatarFileId, undefined);

    const row = await getFile(res.body.fileId as string);
    assert.ok(row, "no file row");
    assert.equal(row.mime, "image/avif", "the picture skipped the avatar processing");
    assert.deepEqual([row.width, row.height], [AVATAR_MAX_PX, AVATAR_MAX_PX]);
    // The image worker only rebuilds avatar thumbnails it finds under this prefix.
    assert.match(row.s3_key, /^avatars\//);
    assert.deepEqual(await storedSize(row.s3_key), [AVATAR_MAX_PX, AVATAR_MAX_PX]);
    assert.ok(row.thumbnail_key, "no thumbnail");
    assert.equal(row.thumbnail_px, AVATAR_THUMB_PX);
    assert.deepEqual(await storedSize(row.thumbnail_key), [AVATAR_THUMB_PX, AVATAR_THUMB_PX]);

    assert.equal((await getUserByServerId(owner.serverUserId))?.avatar_file_id ?? null, null);
  });

  it("leaves the uploader's own avatar alone on the SVG path too", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#e65a1e"/></svg>');
    const res = await uploadAvatar(svg, owner, "image/svg+xml", "hook.svg");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.fileId);
    assert.equal((await getUserByServerId(owner.serverUserId))?.avatar_file_id ?? null, null);
  });

  it("refuses somebody without manage_webhooks, and stores nothing", async () => {
    const carol = await member("carol", "member");
    const before = (await getAllFileRecords()).length;

    const res = await uploadAvatar(big, carol);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.permission, "manage_webhooks");
    assert.equal((await getAllFileRecords()).length, before);
  });

  it("is only the uploader's to read until a webhook wears it", async () => {
    const dave = await member("dave", "member");
    const fileId = await uploadPicture();

    // What PATCH checks before it will set the avatar.
    assert.equal(await fileReadVerdict(fileId, owner.serverUserId, owner.grytUserId), "allowed");
    assert.equal(await fileReadVerdict(fileId, dave.serverUserId, dave.grytUserId), "denied");

    await setAvatar((await createHook()).id, fileId);
    assert.equal(await fileReadVerdict(fileId, dave.serverUserId, dave.grytUserId), "allowed");
  });
});

describe("a webhook post's avatar_url", () => {
  const post = (webhook: { id: string; token: string }) =>
    fetch(`${base}/api/webhooks/${webhook.id}/${webhook.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        avatar_url: "https://ci.example/logo.png",
        cards: [{ title: "Deployed", image_url: "https://ci.example/logo.png" }],
      }),
    });

  it("is stored at the avatar size, while the same picture in a card stays as sent", async () => {
    const webhook = await createHook("deploys");
    const res = await post(webhook);
    assert.equal(res.status, 200, await res.text());

    const [message] = await listMessages("deploys");
    const avatar = await getFile(message.sender_avatar_file_id!);
    assert.ok(avatar, "no avatar file");
    assert.equal(avatar.mime, "image/avif", "the avatar skipped the avatar processing");
    assert.match(avatar.s3_key, /^avatars\//);
    assert.deepEqual(await storedSize(avatar.s3_key), [AVATAR_MAX_PX, AVATAR_MAX_PX]);
    assert.ok(avatar.thumbnail_key, "no thumbnail");

    const image = await getFile(message.cards![0].image_file_id!);
    assert.equal(image?.mime, "image/png");
    assert.deepEqual([image?.width, image?.height], [1600, 1200]);

    // The rules GRYT-1186 gave every picture a webhook sends still hold for this one.
    const ownership = await getFileOwnership(avatar.file_id);
    assert.equal(ownership?.uploadedBy, `webhook:${webhook.id}`);
    assert.deepEqual(ownership?.attachedTo, ["deploys"]);
    assert.deepEqual(await unreferencedAmong([avatar.file_id]), []);
  });

  it("is stored once for a webhook that sends the same one every time", async () => {
    const webhook = await createHook("repeats");
    await post(webhook);
    await post(webhook);

    const [first, second] = await listMessages("repeats");
    assert.ok(first.sender_avatar_file_id);
    assert.equal(first.sender_avatar_file_id, second.sender_avatar_file_id);
    // The same bytes as a card picture are a different file, and stay one on the second post.
    const image = await getFile(second.cards![0].image_file_id!);
    assert.equal(image?.mime, "image/png", "the second post's card picture is the resized avatar");
  });
});
