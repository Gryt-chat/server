import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import express from "express";

import { initSqlite } from "../db/sqlite/connection";
import { ensureDefaultChannels } from "../db/sqlite/channels";
import { openDirectConversation } from "../db/sqlite/conversations";
import { insertFile, insertMessage, listMessages } from "../db/sqlite/messages";
import { createServerConfigIfNotExists, setServerRole } from "../db/sqlite/servers";
import { upsertUser } from "../db/sqlite/users";
import { initStorage, putObject } from "../storage";
import { resetFileAccessCache } from "../services/fileAccess";
import { resetChannelIdCache } from "../socket/utils/conversationAccess";
import { registerChatHandlers } from "../socket/handlers/chat";
import type { HandlerContext } from "../socket/handlers/types";
import type { Clients } from "../types";
import { generateAccessToken, generateFileToken } from "../utils/jwt";
import { uploadsRouter } from "./uploads";

/**
 * Through the route, because the 404 has to be byte-for-byte the one a missing
 * id gets, or the refusal confirms the id exists.
 */

const BUCKET = "gryt-test";
const BODY = "0123456789abcdefghij";

let dir: string;
let server: Server;
let base = "";
let host = "";

interface Member { serverUserId: string; grytUserId: string; nickname: string }
let alice: Member;
let bob: Member;
let mallory: Member;

async function member(nickname: string): Promise<Member> {
  const grytUserId = `acct-${nickname}`;
  const user = await upsertUser(grytUserId, nickname);
  await setServerRole(user.server_user_id, "member");
  return { serverUserId: user.server_user_id, grytUserId, nickname };
}

function fileToken(who: Member): string {
  return generateFileToken({ ...who, serverHost: host, tokenVersion: 0 });
}

async function storedFile(uploader: Member): Promise<string> {
  const fileId = randomUUID();
  const key = `uploads/${fileId}.bin`;
  await putObject({ bucket: BUCKET, key, body: BODY, contentType: "application/octet-stream" });
  await insertFile({
    file_id: fileId, s3_key: key, mime: "video/mp4", size: BODY.length, width: null, height: null,
    thumbnail_key: null, original_name: "clip.mp4", uploaded_by_server_user_id: uploader.serverUserId,
  });
  return fileId;
}

function read(fileId: string, who: Member | null, headers: Record<string, string> = {}) {
  const q = who ? `?t=${encodeURIComponent(fileToken(who))}` : "";
  return fetch(`${base}/api/uploads/files/${fileId}${q}`, { headers });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-fileread-"));
  process.env.DATA_DIR = dir;
  process.env.S3_BUCKET = BUCKET;
  process.env.STORAGE_BACKEND = "filesystem";
  await initSqlite();
  initStorage();
  await createServerConfigIfNotExists();
  await ensureDefaultChannels();
  resetChannelIdCache();

  alice = await member("alice");
  bob = await member("bob");
  mallory = await member("mallory");

  const app = express();
  app.use("/api/uploads", uploadsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
});

beforeEach(() => resetFileAccessCache());

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DATA_DIR;
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_BACKEND;
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/uploads/files/:fileId", () => {
  it("serves a DM attachment to a participant, Range requests included", async () => {
    const { conversation_id } = await openDirectConversation(alice.serverUserId, bob.serverUserId);
    const fileId = await storedFile(alice);
    await insertMessage({ conversation_id, sender_server_id: alice.serverUserId, text: null, attachments: [fileId], reactions: null, reply_to_message_id: null });

    const whole = await read(fileId, bob);
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), BODY);

    for (let i = 0; i < 3; i++) {
      const part = await read(fileId, bob, { Range: "bytes=2-5" });
      assert.equal(part.status, 206);
      assert.equal(await part.text(), "2345");
    }
  });

  it("answers a server member outside the DM exactly as it answers a missing id", async () => {
    const { conversation_id } = await openDirectConversation(alice.serverUserId, bob.serverUserId);
    const fileId = await storedFile(alice);
    await insertMessage({ conversation_id, sender_server_id: alice.serverUserId, text: null, attachments: [fileId], reactions: null, reply_to_message_id: null });

    const refused = await read(fileId, mallory);
    const missing = await read(randomUUID(), mallory);
    assert.equal(refused.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await refused.text(), await missing.text());
  });

  it("serves a pending upload to its uploader and nobody else", async () => {
    const fileId = await storedFile(alice);
    assert.equal((await read(fileId, alice)).status, 200);
    assert.equal((await read(fileId, bob)).status, 404);
  });

  it("still asks for a token before anything else", async () => {
    const fileId = await storedFile(alice);
    assert.equal((await read(fileId, null)).status, 401);
  });
});

describe("attaching a file", () => {
  function chatAs(who: Member) {
    const emitted: { event: string; payload: unknown }[] = [];
    const socket = {
      id: `socket-${who.nickname}`,
      handshake: { headers: { host }, address: "127.0.0.1" },
      emit(event: string, payload?: unknown) { emitted.push({ event, payload }); return true; },
      join() {}, leave() {}, to() { return { emit() {} }; },
    };
    const ctx = {
      io: { to() { return { emit() {} }; }, emit() {}, sockets: { sockets: new Map() } },
      socket, clientId: socket.id, serverId: "file-read-test", clientsInfo: {} as Clients, sfuClient: null,
      getClientIp: () => "127.0.0.1", clientAddressIsOwn: () => true,
    } as unknown as HandlerContext;
    const accessToken = generateAccessToken({ ...who, serverHost: host, tokenVersion: 0 });
    return { handlers: registerChatHandlers(ctx), emitted, accessToken };
  }

  it("refuses an id the sender cannot read, so a private file cannot be reposted in the open", async () => {
    const { conversation_id } = await openDirectConversation(alice.serverUserId, bob.serverUserId);
    const fileId = await storedFile(alice);
    await insertMessage({ conversation_id, sender_server_id: alice.serverUserId, text: null, attachments: [fileId], reactions: null, reply_to_message_id: null });

    const before = (await listMessages("general")).length;
    const mal = chatAs(mallory);
    await mal.handlers["chat:send"]({ conversationId: "general", accessToken: mal.accessToken, text: "look", attachments: [fileId] });

    assert.deepEqual(mal.emitted.find((e) => e.event === "chat:error")?.payload, `Attachment not found: ${fileId}`);
    assert.equal((await listMessages("general")).length, before, "the message was stored anyway");
    assert.equal((await read(fileId, mallory)).status, 404);
  });

  it("lets a participant forward a DM attachment somewhere public", async () => {
    const { conversation_id } = await openDirectConversation(alice.serverUserId, bob.serverUserId);
    const fileId = await storedFile(alice);
    await insertMessage({ conversation_id, sender_server_id: alice.serverUserId, text: null, attachments: [fileId], reactions: null, reply_to_message_id: null });

    const b = chatAs(bob);
    await b.handlers["chat:send"]({ conversationId: "general", accessToken: b.accessToken, text: "sharing", attachments: [fileId] });
    assert.equal(b.emitted.find((e) => e.event === "chat:error"), undefined, JSON.stringify(b.emitted));
    assert.equal((await read(fileId, mallory)).status, 200);
  });
});
