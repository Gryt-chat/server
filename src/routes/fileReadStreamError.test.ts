import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it, mock } from "node:test";

import express from "express";

import { initSqlite } from "../db/sqlite/connection";
import { ensureDefaultChannels } from "../db/sqlite/channels";
import { openDirectConversation } from "../db/sqlite/conversations";
import { insertFile, insertMessage } from "../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import * as storage from "../storage";
import { generateFileToken } from "../utils/jwt";
import { uploadsRouter } from "./uploads";

/** GRYT-1444: Garage's checksum error arrived after the last byte, and with no listener
    on the body it was an uncaught exception that ended the process. */

const BUCKET = "gryt-test";
const BODY = "0123456789abcdefghij";

let dir: string;
let server: Server;
let base = "";
let host = "";
let reader: { serverUserId: string; grytUserId: string; nickname: string };
let fileId = "";

function failingBody(): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(BODY.slice(0, 10));
      setImmediate(() => this.destroy(new Error("Checksum mismatch. Expected: x, calculated: y")));
    },
  });
}

async function download(): Promise<{ status: number; body: string | Error }> {
  const t = generateFileToken({ ...reader, serverHost: host, tokenVersion: 0 });
  // On main the response never ended, so without a deadline this waited forever.
  const signal = AbortSignal.timeout(3000);
  const res = await fetch(`${base}/api/uploads/files/${fileId}?t=${encodeURIComponent(t)}`, { signal });
  try {
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: res.status, body: err as Error };
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-streamerr-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = BUCKET;
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  storage.initStorage();
  await createServerConfigIfNotExists();
  await ensureDefaultChannels();

  const members = [];
  for (const nickname of ["alice", "bob"]) {
    const user = await upsertUser(`acct-${nickname}`, nickname);
    await setServerRole(user.server_user_id, "member");
    members.push({ serverUserId: user.server_user_id, grytUserId: `acct-${nickname}`, nickname });
  }
  const [alice, bob] = members;
  reader = bob;

  fileId = randomUUID();
  const key = `uploads/${fileId}.bin`;
  await storage.putObject({ bucket: BUCKET, key, body: BODY, contentType: "application/octet-stream" });
  await insertFile({
    file_id: fileId, s3_key: key, mime: "video/mp4", size: BODY.length, width: null, height: null,
    thumbnail_key: null, original_name: "clip.mp4", uploaded_by_server_user_id: alice.serverUserId,
  });
  const { conversation_id } = await openDirectConversation(alice.serverUserId, bob.serverUserId);
  await insertMessage({ conversation_id, sender_server_id: alice.serverUserId, text: null, attachments: [fileId], reactions: null, reply_to_message_id: null });

  const app = express();
  app.use("/api/uploads", uploadsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
});

after(async () => {
  mock.restoreAll();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

describe("a storage error partway through a download", () => {
  it("cuts that response short and leaves the server serving", async () => {
    const real = storage.getObject;
    const getObject = mock.method(storage, "getObject", async (params: storage.GetObjectParams) => ({
      ...(await real(params)),
      Body: failingBody(),
    }));

    const broken = await download();
    assert.equal(getObject.mock.callCount(), 1);
    assert.equal(broken.status, 200, "headers were already sent when the error came");
    assert.ok(broken.body instanceof Error, "a short file must not arrive looking whole");
    assert.notEqual(broken.body.name, "TimeoutError", "the response was left hanging");

    getObject.mock.restore();
    const next = await download();
    assert.equal(next.status, 200);
    assert.equal(next.body, BODY);
  });
});
