import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import express from "express";
import sharp from "sharp";

import { initSqlite } from "../db/sqlite/connection";
import { getFile, getFileOwnership, listMessages } from "../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { unreferencedAmong } from "../jobs/mediaSweep";
import { realMediaDeps, type FetchOutcome } from "../services/webhookMedia";
import { getMessagesCached } from "../socket/utils/messageCache";
import { initStorage } from "../storage";
import { generateAccessToken } from "../utils/jwt";
import { setWebhookMediaDepsForTests, webhooksRouter } from "./webhooks";

/** GRYT-1186: cards, their pictures fetched once and stored, and a name that survives a reload. */

let dir: string;
let server: Server;
let base = "";
let token = "";
let picture: Buffer;
let fetches: string[] = [];

const respond = async (url: string): Promise<FetchOutcome> => {
  fetches.push(url);
  if (url.includes("missing")) return { ok: false, code: "fetch_failed" };
  return { ok: true, bytes: picture };
};

async function call(path: string, body: unknown, auth = false) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createHook(channel = "general"): Promise<{ id: string; url: string }> {
  const res = await call("/api/webhooks", { channel_id: channel, display_name: "CI" }, true);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.webhook_id as string, url: `/api/webhooks/${res.body.webhook_id}/${res.body.token}` };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-webhookcards-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = "gryt-test";
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();
  picture = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 60, g: 110, b: 140 } } }).png().toBuffer();

  const user = await upsertUser("acct-owner", "owner");
  await setServerRole(user.server_user_id, "owner");

  const app = express();
  app.use("/api/webhooks", webhooksRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
  token = generateAccessToken({ serverUserId: user.server_user_id, grytUserId: "acct-owner", nickname: "owner", serverHost: host, tokenVersion: 0 });
  setWebhookMediaDepsForTests({ fetchBytes: respond, storeImage: realMediaDeps.storeImage });
});

beforeEach(() => { fetches = []; });

after(async () => {
  setWebhookMediaDepsForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

describe("posting cards through a webhook", () => {
  it("still posts plain text, and answers with no warnings", async () => {
    const hook = await createHook("plain");
    const res = await call(hook.url, { text: "deployed" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.warnings, []);
    const [message] = await listMessages("plain");
    assert.equal(message.text, "deployed");
    assert.equal(message.cards, undefined);
    assert.equal(message.text_fallback, undefined);
  });

  it("stores the cards with file ids, and the files are the channel's", async () => {
    const hook = await createHook("deploys");
    const res = await call(hook.url, {
      display_name: "Build runner",
      avatar_url: "https://ci.example/avatar.png",
      cards: [{
        title: "Deploy finished",
        description: "Rolled out in **4 minutes**.",
        color: "#3FB27F",
        author: { name: "Runner", icon_url: "https://ci.example/icon.png" },
        fields: [{ name: "Env", value: "production", inline: true }],
        image_url: "https://ci.example/graph.png",
        thumbnail_url: "https://ci.example/missing.png",
        footer: { text: "ci.example", icon_url: "https://ci.example/icon.png" },
        timestamp: "2026-09-15T07:42:00Z",
      }],
      embeds: [],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      (res.body.warnings as { path: string; code: string }[]).map((w) => [w.path, w.code]),
      [["embeds", "unknown_key"], ["cards[0].thumbnail_url", "fetch_failed"]],
    );

    const [message] = await listMessages("deploys");
    assert.equal(message.text, "Deploy finished");
    assert.equal(message.text_fallback, true);
    assert.equal(message.sender_display_name, "Build runner");
    const card = message.cards![0];
    assert.equal(card.color, "#3fb27f");
    assert.equal(card.thumbnail_file_id, undefined);
    assert.equal(card.author!.icon_file_id, card.footer!.icon_file_id);

    const files = [message.sender_avatar_file_id!, card.image_file_id!, card.author!.icon_file_id!];
    for (const fileId of files) {
      assert.ok(await getFile(fileId), `file ${fileId} was not stored`);
      assert.deepEqual((await getFileOwnership(fileId))?.attachedTo, ["deploys"]);
    }
    assert.deepEqual(await unreferencedAmong(files), [], "the media sweep would delete a card's pictures");
  });

  it("keeps the posted name and picture in history and the cache", async () => {
    const hook = await createHook("names");
    // Somebody opened the channel first, so its first page is cached and empty.
    assert.deepEqual(await getMessagesCached("names"), []);
    await call(hook.url, { text: "one", display_name: "Nightly", avatar_url: "https://ci.example/night.png" });
    await call(hook.url, { text: "two" });

    const [first, second] = await listMessages("names");
    assert.equal(first.sender_display_name, "Nightly");
    assert.ok(first.sender_avatar_file_id);
    assert.equal(second.sender_display_name, undefined, "without an override the webhook's own name applies");

    const cached = await getMessagesCached("names");
    assert.deepEqual(cached.map((m) => m.text), ["one", "two"], "the webhook's messages never reached the cache");
  });

  it("stores one file for the same picture sent twice", async () => {
    const hook = await createHook("dedupe");
    await call(hook.url, { cards: [{ title: "a", image_url: "https://ci.example/a.png" }] });
    await call(hook.url, { cards: [{ title: "b", image_url: "https://ci.example/b.png" }] });
    const [a, b] = await listMessages("dedupe");
    assert.equal(a.cards![0].image_file_id, b.cards![0].image_file_id);
  });

  it("refuses a bad payload before fetching anything", async () => {
    const hook = await createHook("refused");
    const res = await call(hook.url, { cards: [{ title: "t", image_url: "https://ci.example/a.png", color: "green" }, {}] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_payload");
    assert.deepEqual(
      (res.body.problems as { path: string; code: string }[]).map((p) => [p.path, p.code]),
      [["cards[0].color", "invalid_color"], ["cards[1]", "empty_card"]],
    );
    assert.deepEqual(fetches, []);
    assert.deepEqual(await listMessages("refused"), []);
  });

  it("answers an empty message the way it did before cards", async () => {
    const hook = await createHook("empty");
    const res = await call(hook.url, { text: "  " });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "empty_message");
  });
});

describe("text over the limit", () => {
  it("gets the same refusal it always did", async () => {
    const hook = await createHook("long");
    const res = await call(hook.url, { text: "x".repeat(4001) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "message_too_long");
  });
});
