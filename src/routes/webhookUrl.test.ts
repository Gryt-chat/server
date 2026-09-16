import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import { initSqlite } from "../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { generateAccessToken } from "../utils/jwt";
import { webhooksRouter } from "./webhooks";

/** Behind a Cloudflare tunnel the copied URL started http://, and a post to it met a 301 (GRYT-1303). */

let dir: string;
let server: Server;
let base = "";
let host = "";
let token = "";

async function call(path: string, init: RequestInit, proto?: string) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(proto ? { "X-Forwarded-Proto": proto } : {}),
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const create = (proto?: string) =>
  call("/api/webhooks", { method: "POST", body: JSON.stringify({ channel_id: "general", display_name: "CI" }) }, proto);

const pathOf = (body: Record<string, unknown>) => `/api/webhooks/${body.webhook_id}/${body.token}`;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-webhookurl-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();
  const user = await upsertUser("acct-url-owner", "owner");
  await setServerRole(user.server_user_id, "owner");

  const app = express();
  app.use("/api/webhooks", webhooksRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
  token = generateAccessToken({
    serverUserId: user.server_user_id,
    grytUserId: "acct-url-owner",
    nickname: "owner",
    serverHost: host,
    tokenVersion: 0,
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.GRYT_TRUSTED_PROXY_HOPS;
  rmSync(dir, { recursive: true, force: true });
});

describe("a webhook's URL", () => {
  it("ignores x-forwarded-proto when no proxy is trusted", async () => {
    delete process.env.GRYT_TRUSTED_PROXY_HOPS;
    const res = await create("https");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.url, `http://${host}${pathOf(res.body)}`);
  });

  it("uses https when a trusted proxy says the client came in over https", async () => {
    process.env.GRYT_TRUSTED_PROXY_HOPS = "1";
    const created = await create("https");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.url, `https://${host}${pathOf(created.body)}`);

    const read = await call(`/api/webhooks/${created.body.webhook_id}`, { method: "GET" }, "https");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.url, created.body.url);
  });

  it("stays http behind a trusted proxy that sends no header", async () => {
    process.env.GRYT_TRUSTED_PROXY_HOPS = "1";
    const res = await create();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.url, `http://${host}${pathOf(res.body)}`);
  });
});
