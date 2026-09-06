import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getServerChannel, upsertServerChannel } from "../../db/sqlite/channels";
import { initSqlite } from "../../db/sqlite/connection";
import { createServerConfigIfNotExists, setServerRole } from "../../db/sqlite/servers";
import { claimBotRegistration, createBotRegistration } from "../../db/sqlite/bots";
import { upsertUser } from "../../db/sqlite/users";
import type { Clients } from "../../types";
import { generateAccessToken } from "../../utils/jwt";
import { registerChatHandlers } from "./chat";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Automated channels, and the one rule they exist for: only bots (and webhooks
 * and system messages, which never reach this handler) may post. A human with
 * send_messages is refused. The gate keys off the identity in the verified
 * token — a BOT_ subject is a bot, anything else is a person — so it can't be
 * argued around by a client.
 */

const HOST = "automated.test:5001";
const CHAN_NORMAL = "chan-normal";
const CHAN_AUTO = "chan-auto";

interface Party {
  serverUserId: string;
  accessToken: string;
  handlers: EventHandlerMap;
  received: (event: string) => unknown[];
}

let dir: string;
const sockets = new Map<string, { emit: (e: string, p?: unknown) => boolean }>();
const clientsInfo: Clients = {};
let human: Party;
let bot: Party;

function makeParty(seq: number, grytUserId: string, nickname: string, serverUserId: string): Party {
  const clientId = `socket-${seq}`;
  const emitted: { event: string; payload?: unknown }[] = [];
  const record = {
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload });
      return true;
    },
  };
  sockets.set(clientId, record);

  const socket = {
    id: clientId,
    handshake: { headers: { host: HOST }, address: "127.0.0.1" },
    emit: record.emit,
    join() {},
    leave() {},
    to: () => ({ emit() {} }),
  };

  clientsInfo[clientId] = { serverUserId, grytUserId, nickname } as Clients[string];

  const ctx = {
    io: { sockets: { sockets } },
    socket,
    clientId,
    serverId: "automated-test",
    clientsInfo,
    sfuClient: null,
    getClientIp: () => `10.0.0.${seq}`,
    clientAddressIsOwn: () => true,
  } as unknown as HandlerContext;

  return {
    serverUserId,
    accessToken: generateAccessToken({ grytUserId, serverUserId, nickname, serverHost: HOST, tokenVersion: 0 }),
    handlers: registerChatHandlers(ctx),
    received: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-automated-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await upsertServerChannel({ channelId: CHAN_NORMAL, name: "normal", type: "text" });
  await upsertServerChannel({ channelId: CHAN_AUTO, name: "git-activity", type: "text", automated: true });

  const h = await upsertUser("account-human", "Human");
  await setServerRole(h.server_user_id, "owner");

  // The bot is a member like anyone else, but a bot's permissions come from an
  // approved registry grant, not a role. Grant it send_messages and bind the
  // registration to its BOT_ identity — the prefix isBotIdentity reads.
  const b = await upsertUser("BOT_deadbeef", "Release Bot");
  const reg = await createBotRegistration({
    nickname: "Release Bot",
    grantedPermissions: ["read_messages", "send_messages"],
    createdByServerUserId: h.server_user_id,
  });
  await claimBotRegistration(reg.claim_token as string, "BOT_deadbeef");

  human = makeParty(1, "account-human", "Human", h.server_user_id);
  bot = makeParty(2, "BOT_deadbeef", "Release Bot", b.server_user_id);
});

after(() => {
  delete process.env.DATA_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file open past the run; a leftover temp dir is
    // not worth failing the suite over.
  }
});

describe("automated channel write policy", () => {
  it("refuses a human posting in an automated channel", async () => {
    await human.handlers["chat:send"]({
      conversationId: CHAN_AUTO,
      text: "let me in",
      accessToken: human.accessToken,
    });

    assert.equal(human.received("chat:new").length, 0, "the human's message was accepted");
    const errors = human.received("chat:error") as { error?: string }[];
    assert.ok(
      errors.some((e) => e?.error === "automated_channel"),
      "the human was not refused with automated_channel",
    );
  });

  it("lets a bot post in an automated channel", async () => {
    await bot.handlers["chat:send"]({
      conversationId: CHAN_AUTO,
      text: "Published v1.9.20",
      accessToken: bot.accessToken,
    });

    assert.deepEqual(bot.received("chat:error"), [], "the bot was refused");
    const sent = bot.received("chat:new").at(-1) as { message_id?: string } | undefined;
    assert.ok(sent?.message_id, "the bot's message was not accepted");
  });

  it("leaves a normal channel open to humans", async () => {
    // The same human was refused above, so its error history is not empty —
    // assert on this send landing a new chat:new rather than on a clean slate.
    const before = human.received("chat:new").length;
    await human.handlers["chat:send"]({
      conversationId: CHAN_NORMAL,
      text: "hello everyone",
      accessToken: human.accessToken,
    });

    const news = human.received("chat:new") as { message_id?: string; text?: string }[];
    assert.equal(news.length, before + 1, "a normal channel refused a human");
    assert.equal(news.at(-1)?.text, "hello everyone");
  });
});

describe("channel layout and write-policy persistence", () => {
  it("stores a forum layout on a text channel", async () => {
    await upsertServerChannel({ channelId: "chan-forum", name: "support", type: "text", layout: "forum" });
    const c = await getServerChannel("chan-forum");
    assert.equal(c?.layout, "forum");
    assert.equal(c?.automated, false);
  });

  it("defaults an ordinary channel to chat layout, not automated", async () => {
    const c = await getServerChannel(CHAN_NORMAL);
    assert.equal(c?.layout, "chat");
    assert.equal(c?.automated, false);
  });

  it("ignores forum and automated on a voice channel", async () => {
    await upsertServerChannel({
      channelId: "chan-voice",
      name: "voice",
      type: "voice",
      layout: "forum",
      automated: true,
    });
    const c = await getServerChannel("chan-voice");
    assert.equal(c?.layout, "chat", "a voice channel should never be a forum");
    assert.equal(c?.automated, false, "a voice channel should never be automated");
  });
});
