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
import { createGroupConversation, setConversationIcon } from "../db/sqlite/conversations";
import { getFile, getFileOwnership } from "../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { getUserByServerId, upsertUser } from "../db/sqlite/users";
import { unreferencedAmong } from "../jobs/mediaSweep";
import { fileReadVerdict } from "../services/fileAccess";
import { initStorage } from "../storage";
import { generateAccessToken } from "../utils/jwt";
import { uploadsRouter } from "./uploads";

/**
 * Choosing a group's picture went through the avatar route, which also made it
 * the uploader's own avatar (GRYT-1182).
 */

let dir: string;
let server: Server;
let base = "";
let host = "";

interface Member { serverUserId: string; grytUserId: string; nickname: string }

async function member(nickname: string): Promise<Member> {
  const grytUserId = `acct-${nickname}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");
  return { serverUserId: user.server_user_id, grytUserId, nickname };
}

async function upload(path: string, who: Member, body: Buffer, type: string, name: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(body)], { type }), name);
  const token = generateAccessToken({ ...who, serverHost: host, tokenVersion: 0 });
  const res = await fetch(`${base}/api/uploads/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const png = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 160, b: 140 } } }).png().toBuffer();

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#14a08c"/></svg>');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-groupicon-"));
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
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/uploads/group-icon", () => {
  it("stores the picture without touching the uploader's avatar", async () => {
    const alice = await member("alice");
    const res = await upload("group-icon", alice, await png(), "image/png", "group.png");

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const fileId = res.body.fileId as string;
    assert.ok(fileId, "no fileId in the reply");
    assert.equal(res.body.avatarFileId, undefined);

    assert.equal((await getUserByServerId(alice.serverUserId))?.avatar_file_id ?? null, null);
    const row = await getFile(fileId);
    assert.equal(row?.mime, "image/avif", "the picture skipped the avatar processing");
    assert.equal((await getFileOwnership(fileId))?.uploadedBy, alice.serverUserId);
    // What `dm:group:update` checks before it will set the icon.
    assert.equal(await fileReadVerdict(fileId, alice.serverUserId, alice.grytUserId), "allowed");
  });

  it("leaves the avatar alone on the SVG path too", async () => {
    const bob = await member("bob");
    const res = await upload("group-icon", bob, SVG, "image/svg+xml", "group.svg");

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.fileId);
    assert.equal((await getUserByServerId(bob.serverUserId))?.avatar_file_id ?? null, null);
  });

  it("refuses what the avatar route refuses", async () => {
    const carol = await member("carol");
    const res = await upload("group-icon", carol, Buffer.from("not a picture"), "text/plain", "x.txt");
    assert.equal(res.status, 400);
  });

  it("is still what sets an avatar on the avatar route", async () => {
    const dave = await member("dave");
    const res = await upload("avatar", dave, await png(), "image/png", "me.png");

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await getUserByServerId(dave.serverUserId))?.avatar_file_id, res.body.avatarFileId);
  });

  it("is kept by the media sweep once a group wears it", async () => {
    const [erin, frank, gina] = [await member("erin"), await member("frank"), await member("gina")];
    const res = await upload("group-icon", erin, await png(), "image/png", "group.png");
    const fileId = res.body.fileId as string;

    // Nothing points at it yet, so a picture chosen and then abandoned is swept.
    assert.deepEqual(await unreferencedAmong([fileId]), [fileId]);

    const group = await createGroupConversation(erin.serverUserId, [frank.serverUserId, gina.serverUserId]);
    await setConversationIcon(group.conversation_id, fileId);
    assert.deepEqual(await unreferencedAmong([fileId]), []);
  });
});
