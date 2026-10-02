import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";
import sharp from "sharp";

import { initSqlite } from "../db/sqlite/connection";
import { getFile, updateFileRecord } from "../db/sqlite/messages";
import { createRoleDefinition } from "../db/sqlite/roleDefinitions";
import { createServerConfigIfNotExists, setServerRole, updateServerConfig } from "../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../db/sqlite/users";
import { unreferencedAmong } from "../jobs/mediaSweep";
import { fileReadVerdict } from "../services/fileAccess";
import { buildMemberList } from "../socket/utils/clients";
import { initStorage } from "../storage";
import { generateAccessToken, generateFileToken } from "../utils/jwt";
import { getImageJob, updateImageJobStatus } from "../db/sqlite/imageJobs";
import { apiErrorHandler } from "../utils/httpErrors";
import { realMediaDeps } from "../services/webhookMedia";
import { uploadsRouter } from "./uploads";

/** The member card banner: the avatar pipeline cut to 5:2. */

let dir: string;
let server: Server;
let base = "";
let host = "";

interface Member { serverUserId: string; grytUserId: string; nickname: string }

async function member(nickname: string, role = "member"): Promise<Member> {
  const grytUserId = `acct-banner-${nickname}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, role);
  return { serverUserId: user.server_user_id, grytUserId, nickname };
}

function auth(who: Member) {
  return { Authorization: `Bearer ${generateAccessToken({ ...who, serverHost: host, tokenVersion: 0 })}` };
}

async function upload(who: Member, body: Buffer, type = "image/png", name = "banner.png", endpoint = "/banner", sealed = false) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(body)], { type }), name);
  if (sealed) form.append("sealed", "1");
  const res = await fetch(`${base}/api/uploads${endpoint}`, { method: "POST", headers: auth(who), body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function remove(who: Member) {
  const res = await fetch(`${base}/api/uploads/banner`, { method: "DELETE", headers: auth(who) });
  return res.status;
}

const png = (width = 1600, height = 900) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 90 } } }).png().toBuffer();
const mp4 = () => readFileSync(join(__dirname, "../utils/testdata/landscape.mp4"));

const bannerOf = async (m: Member) => (await getUserByServerId(m.serverUserId))?.banner_file_id ?? null;
const rowOf = async (m: Member) => (await buildMemberList({})).find((r) => r.serverUserId === m.serverUserId);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-banner-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt-test";
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();
  // A newcomer on the community server: may talk, may not upload pictures.
  await createRoleDefinition("newcomer", { name: "Newcomer", rank: 5, permissions: ["send_messages", "change_avatar", "upload_avatar_image"] });

  const app = express();
  app.use("/api/uploads", uploadsRouter);
  app.use(apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
});

describe("shared chat upload processing", () => {
  it("keeps webhook pictures quarantined behind a file-id worker verdict", async () => {
    const bytes = await png(20, 20);
    const fileId = await realMediaDeps.storeImage("hook-quarantine", bytes, "png", 20, 20);
    assert.ok((await getFile(fileId))?.s3_key.startsWith("quarantine/uploads/"));
    assert.equal((await getImageJob(fileId))?.status, "queued");
  });
  it("quarantines media even when the upload claims to be an ordinary attachment", async () => {
    const who = await member("mislabelled-chat");
    for (const [bytes, expected] of [[await png(20, 20), "image/png"], [mp4(), "video/mp4"]] as const) {
      const response = await upload(who, bytes, "application/octet-stream", "attachment.bin", "");
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const fileId = response.body.fileId as string;
      assert.equal(response.body.processing, true);
      assert.equal((await getFile(fileId))?.mime, expected);
      assert.equal((await getImageJob(fileId))?.status, "queued");
      const token = generateFileToken({ ...who, serverHost: host, tokenVersion: 0 });
      assert.equal((await fetch(`${base}/api/uploads/files/${fileId}?t=${encodeURIComponent(token)}`)).status, 503);
    }
  });
  it("blocks new unencrypted pictures until the worker approves them", async () => {
    const who = await member("chat-picture");
    const bytes = await png(16, 16);
    const response = await upload(who, bytes, "image/png", "chat.png", "");
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const fileId = response.body.fileId as string;
    assert.equal(response.body.processing, true);
    assert.ok((await getFile(fileId))?.s3_key.startsWith("quarantine/uploads/"));
    assert.equal((await getImageJob(fileId))?.status, "queued");
    const token = generateFileToken({ ...who, serverHost: host, tokenVersion: 0 });
    const url = `${base}/api/uploads/files/${fileId}?t=${encodeURIComponent(token)}`;
    assert.equal((await fetch(url)).status, 503);
    await updateImageJobStatus({ job_id: fileId, status: "done" });
    const ready = await fetch(url);
    assert.equal(ready.status, 200);
    assert.deepEqual(Buffer.from(await ready.arrayBuffer()), bytes);
  });

  it("keeps encrypted attachments opaque and does not pass ciphertext to a decoder", async () => {
    const who = await member("sealed-chat");
    const bytes = Buffer.from("opaque encrypted bytes");
    const response = await upload(who, bytes, "image/png", "private.png", "", true);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const fileId = response.body.fileId as string;
    assert.equal(response.body.processing, false);
    assert.equal(await getImageJob(fileId), null);
    assert.equal((await getFile(fileId))?.mime, "application/octet-stream");
    const token = generateFileToken({ ...who, serverHost: host, tokenVersion: 0 });
    const ready = await fetch(`${base}/api/uploads/files/${fileId}?t=${encodeURIComponent(token)}`);
    assert.equal(ready.status, 200);
    assert.match(ready.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.deepEqual(Buffer.from(await ready.arrayBuffer()), bytes);
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/uploads/banner", () => {
  it("quarantines the picture for the worker, beside the avatar", async () => {
    const alice = await member("alice");
    const res = await upload(alice, await png());

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const fileId = res.body.bannerFileId as string;
    assert.ok(fileId);
    assert.equal(await bannerOf(alice), fileId);
    assert.equal((await getUserByServerId(alice.serverUserId))?.avatar_file_id ?? null, null, "it became the avatar");

    const file = await getFile(fileId);
    assert.equal(file?.mime, "image/png");
    assert.equal(file?.width, null);
    assert.equal(file?.height, null);
    assert.ok(file?.s3_key.startsWith("quarantine/banners/"));
    assert.equal((await getImageJob(fileId))?.status, "queued");
  });

  it("is refused to a member who may not upload, and nothing is stored", async () => {
    const newcomer = await member("newcomer", "newcomer");
    const res = await upload(newcomer, await png());
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(await bannerOf(newcomer), null);
  });

  it("refuses an SVG and anything that is not a picture", async () => {
    const bob = await member("bob");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>');
    assert.equal((await upload(bob, svg, "image/svg+xml", "b.svg")).status, 400);
    assert.equal((await upload(bob, Buffer.from("not a picture"), "text/plain", "b.txt")).status, 400);
    assert.equal(await bannerOf(bob), null);
  });

  it("stores a readable MP4 without flattening its animation", async () => {
    const player = await member("player");
    const res = await upload(player, mp4(), "video/mp4", "loop.mp4");
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const file = await getFile(res.body.bannerFileId as string);
    assert.equal(file?.mime, "video/mp4");
    assert.equal(file?.width, 160);
    assert.equal(file?.height, 90);
    assert.equal((await getImageJob(res.body.bannerFileId as string))?.status, "queued");
  });

  it("keeps bytes merely labelled as MP4 unreadable until the worker checks them", async () => {
    const poser = await member("poser");
    const res = await upload(poser, Buffer.from("not a video"), "video/mp4", "fake.mp4");
    assert.equal(res.status, 201);
    const fileId = res.body.bannerFileId as string;
    const token = generateFileToken({ ...poser, serverHost: host, tokenVersion: 0 });
    const url = `${base}/api/uploads/files/${fileId}?t=${encodeURIComponent(token)}`;
    const pending = await fetch(url);
    assert.equal(pending.status, 503);
    assert.equal(pending.headers.get("cache-control"), "no-store");
    await updateImageJobStatus({ job_id: fileId, status: "error", error_message: "invalid video" });
    assert.equal((await fetch(url)).status, 422);
  });

  it("serves a video only after a successful worker verdict, including range reads", async () => {
    const verified = await member("verified");
    const res = await upload(verified, mp4(), "video/mp4", "loop.mp4");
    const fileId = res.body.bannerFileId as string;
    const token = generateFileToken({ ...verified, serverHost: host, tokenVersion: 0 });
    const url = `${base}/api/uploads/files/${fileId}?t=${encodeURIComponent(token)}`;
    assert.equal((await fetch(url, { method: "HEAD" })).status, 503);
    assert.equal((await fetch(`${url}&thumb=1`)).status, 503);
    await updateImageJobStatus({ job_id: fileId, status: "done" });
    assert.equal((await fetch(url)).status, 422, "a done job without a decoded poster must remain blocked");
    await updateFileRecord(fileId, { thumbnail_key: `thumbnails/${fileId}.jpg` });
    const ready = await fetch(url, { headers: { Range: "bytes=0-15" } });
    assert.equal(ready.status, 206);
    assert.equal((await ready.arrayBuffer()).byteLength, 16);
  });

  it("enforces the configured upload limit on both pictures and videos", async () => {
    const limited = await member("limited");
    await updateServerConfig({ uploadMaxBytes: 512 });
    try {
      for (const [bytes, type] of [[await png(), "image/png"], [mp4(), "video/mp4"]] as const) {
        const res = await upload(limited, bytes, type);
        assert.equal(res.status, 413, JSON.stringify(res.body));
        assert.equal(res.body.error, "file_too_large");
        assert.equal(await bannerOf(limited), null);
      }
    } finally {
      await updateServerConfig({ uploadMaxBytes: null });
    }
  });

  it("deletes the old banner when it is replaced", async () => {
    const carol = await member("carol");
    const first = (await upload(carol, await png())).body.bannerFileId as string;
    const second = (await upload(carol, await png(1200, 480))).body.bannerFileId as string;

    assert.notEqual(first, second);
    assert.equal(await bannerOf(carol), second);
    assert.equal(await getFile(first), null, "the replaced banner is still stored");
    assert.ok(await getFile(second));
  });

  it("is kept by the media sweep while it is worn", async () => {
    const dave = await member("dave");
    const fileId = (await upload(dave, await png())).body.bannerFileId as string;
    assert.deepEqual(await unreferencedAmong([fileId]), []);
  });

  it("is readable by other members, like an avatar", async () => {
    const erin = await member("erin");
    const frank = await member("frank");
    const fileId = (await upload(erin, await png())).body.bannerFileId as string;
    assert.equal(await fileReadVerdict(fileId, frank.serverUserId, frank.grytUserId), "allowed");
  });
});

describe("DELETE /api/uploads/banner", () => {
  it("clears the banner and deletes the file", async () => {
    const gina = await member("gina");
    const fileId = (await upload(gina, await png())).body.bannerFileId as string;
    assert.equal(await remove(gina), 200);
    assert.equal(await bannerOf(gina), null);
    assert.equal(await getFile(fileId), null);
  });

  it("works after the upload permission is gone", async () => {
    const hana = await member("hana");
    await upload(hana, await png());
    await setServerRole(hana.serverUserId, "newcomer");
    assert.equal(await remove(hana), 200);
    assert.equal(await bannerOf(hana), null);
  });
});

describe("the banner in the member list", () => {
  it("is sent while the member may upload", async () => {
    const ivan = await member("ivan");
    const fileId = (await upload(ivan, await png())).body.bannerFileId as string;
    assert.equal((await rowOf(ivan))?.bannerFileId, fileId);
  });

  it("is not sent once the member may not upload any more", async () => {
    const jo = await member("jo");
    await upload(jo, await png());
    await setServerRole(jo.serverUserId, "newcomer");
    assert.equal((await rowOf(jo))?.bannerFileId, null);
  });

  it("is null for somebody who never set one", async () => {
    const kim = await member("kim");
    assert.equal((await rowOf(kim))?.bannerFileId, null);
  });
});
