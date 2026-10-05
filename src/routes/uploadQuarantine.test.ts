import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";
import sharp from "sharp";

import { getSqliteDb, initSqlite } from "../db/sqlite/connection";
import { getFile } from "../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../db/sqlite/users";
import { refreshWorkerCapabilities } from "../services/workerCapabilities";
import { buildMemberList } from "../socket/utils/clients";
import { initStorage, putObject } from "../storage";
import { generateAccessToken, generateFileToken } from "../utils/jwt";

/* GRYT-1664: with a worker that clears quarantine, an avatar or banner is stored out of reach
   and nobody is ever served the bytes as sent; a read waits for the worker's copy instead. */

process.env.GRYT_QUARANTINE_WAIT_MS = "1500";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { uploadsRouter } = require("./uploads") as typeof import("./uploads");

let dir: string;
let server: Server;
let base = "";
let host = "";

interface Member { serverUserId: string; grytUserId: string; nickname: string }

async function member(nickname: string): Promise<Member> {
  const grytUserId = `acct-quarantine-${nickname}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");
  return { serverUserId: user.server_user_id, grytUserId, nickname };
}

const auth = (who: Member) => ({ Authorization: `Bearer ${generateAccessToken({ ...who, serverHost: host, tokenVersion: 0 })}` });
const png = () => sharp({ create: { width: 800, height: 600, channels: 3, background: "#c83c5a" } }).png().toBuffer();
const workerSays = (capabilities: string[]) =>
  refreshWorkerCapabilities("http://worker.test", (async () => new Response(JSON.stringify({ capabilities }))) as typeof fetch);

async function upload(who: Member, path: "banner" | "avatar") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(await png())], { type: "image/png" }), "picture.png");
  const res = await fetch(`${base}/api/uploads/${path}`, { method: "POST", headers: auth(who), body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** What the worker does when it finishes: the row moves out of quarantine, or the job is marked failed. */
const workerWritesOut = (fileId: string, key: string, mimeType: string) => {
  getSqliteDb().prepare("UPDATE files SET s3_key = ?, mime = ? WHERE file_id = ?").run(key, mimeType, fileId);
  getSqliteDb().prepare("UPDATE image_jobs SET status = 'done' WHERE file_id = ?").run(fileId);
};
const workerRefuses = (fileId: string) =>
  getSqliteDb().prepare("UPDATE image_jobs SET status = 'error', error_message = 'could not be decoded' WHERE file_id = ?").run(fileId);
const until = async (check: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const read = (who: Member, fileId: string) =>
  fetch(`${base}/api/uploads/files/${fileId}?t=${encodeURIComponent(generateFileToken({ ...who, serverHost: host, tokenVersion: 0 }))}`);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-quarantine-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt-test";
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();
  const app = express();
  app.use("/api/uploads", uploadsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("uploads with a worker that clears quarantine", () => {
  it("stores a banner out of reach and queues it for the worker", async () => {
    assert.equal(await workerSays(["quarantine-v1"]), true);
    const alice = await member("alice");
    const res = await upload(alice, "banner");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const fileId = res.body.bannerFileId as string;
    assert.equal(res.body.processing, true);
    assert.equal((await getUserByServerId(alice.serverUserId))?.banner_file_id ?? null, null, "not theirs until written out");
    const file = await getFile(fileId);
    assert.ok(file?.s3_key.startsWith("quarantine/banners/"), file?.s3_key);
    const job = getSqliteDb().prepare("SELECT raw_s3_key, status FROM image_jobs WHERE file_id = ?").get(fileId) as { raw_s3_key: string; status: string };
    assert.deepEqual({ ...job }, { raw_s3_key: file!.s3_key, status: "queued" });

    workerWritesOut(fileId, `banners/${fileId}.avif`, "image/avif");
    await until(async () => (await getUserByServerId(alice.serverUserId))?.banner_file_id === fileId);
  });

  it("keeps the working avatar when the worker refuses the new one, and drops the refused file", async () => {
    await workerSays(["quarantine-v1"]);
    const erin = await member("erin");
    const first = (await upload(erin, "avatar")).body.avatarFileId as string;
    workerWritesOut(first, `avatars/${first}.avif`, "image/avif");
    await until(async () => (await getUserByServerId(erin.serverUserId))?.avatar_file_id === first);

    const second = (await upload(erin, "avatar")).body.avatarFileId as string;
    workerRefuses(second);
    const started = Date.now();
    const refused = await read(erin, second);
    assert.ok(refused.status === 404 || refused.status === 401, String(refused.status));
    assert.ok(Date.now() - started < 1000, "a refused file is answered at once, not after the wait");
    await until(async () => (await getFile(second)) === null);
    assert.equal((await getUserByServerId(erin.serverUserId))?.avatar_file_id, first);
  });

  it("applies only the newest of two uploads, whichever the worker finishes first", async () => {
    await workerSays(["quarantine-v1"]);
    const finn = await member("finn");
    const older = (await upload(finn, "banner")).body.bannerFileId as string;
    const newer = (await upload(finn, "banner")).body.bannerFileId as string;
    workerWritesOut(newer, `banners/${newer}.avif`, "image/avif");
    await until(async () => (await getUserByServerId(finn.serverUserId))?.banner_file_id === newer);
    workerWritesOut(older, `banners/${older}.avif`, "image/avif");
    await until(async () => (await getFile(older)) === null);
    assert.equal((await getUserByServerId(finn.serverUserId))?.banner_file_id, newer);
  });

  it("never serves the original: a read waits for the worker's copy, and says not ready if it never comes", async () => {
    await workerSays(["quarantine-v1"]);
    const bob = await member("bob");
    const fileId = (await upload(bob, "avatar")).body.avatarFileId as string;
    assert.ok((await getFile(fileId))?.s3_key.startsWith("quarantine/avatars/"));

    const notYet = await read(bob, fileId);
    assert.equal(notYet.status, 503);
    assert.equal(notYet.headers.get("cache-control"), "no-store");

    // The worker writes its copy and moves the row while a read is waiting.
    const waiting = read(bob, fileId);
    const fresh = Buffer.from("written out again by the worker");
    setTimeout(() => {
      void putObject({ bucket: "gryt-test", key: `avatars/${fileId}.avif`, body: fresh, contentType: "image/avif" }).then(() =>
        getSqliteDb().prepare("UPDATE files SET s3_key = ?, mime = ?, size = ? WHERE file_id = ?").run(`avatars/${fileId}.avif`, "image/avif", fresh.length, fileId));
    }, 300);
    const res = await waiting;
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fresh);
  });

  it("keeps the old path when the worker does not say it clears quarantine", async () => {
    assert.equal(await workerSays([]), false);
    const carol = await member("carol");
    const fileId = (await upload(carol, "banner")).body.bannerFileId as string;
    assert.ok((await getFile(fileId))?.s3_key.startsWith("banners/"));
  });

  it("takes a banner video only from a worker that transcodes, and never decodes it here", async () => {
    const dave = await member("dave");
    const sendVideo = async () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(Buffer.from("not decoded by the server"))], { type: "video/mp4" }), "clip.mp4");
      const res = await fetch(`${base}/api/uploads/banner`, { method: "POST", headers: auth(dave), body: form });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    await workerSays(["quarantine-v1"]);
    const refused = await sendVideo();
    assert.equal(refused.status, 415);
    assert.equal(refused.body.error, "video_unsupported");

    await workerSays(["quarantine-v1", "video-v1"]);
    const taken = await sendVideo();
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    const videoId = taken.body.bannerFileId as string;
    const file = await getFile(videoId);
    assert.ok(file?.s3_key.startsWith("quarantine/banners/"));
    assert.equal(file?.mime, "video/mp4");
    workerWritesOut(videoId, `banners/${videoId}.mp4`, "video/mp4");
    await until(async () => (await getUserByServerId(dave.serverUserId))?.banner_file_id === videoId);
    const row = (await buildMemberList({})).find((m) => m.serverUserId === dave.serverUserId);
    assert.equal(row?.bannerVideo, true, "the member list says it plays");
    assert.equal(row?.avatarVideo, false);
  });
});
