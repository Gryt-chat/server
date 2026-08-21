import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { identityTierOf, isBotIdentity, looksLikeABotName } from "../../auth/identity";
import { getEffectiveStanding } from "../../services/permissions";
import { initSqlite } from "./connection";
import {
  claimBotRegistration,
  createBotRegistration,
  decideBot,
  deleteBotRegistration,
  getBotById,
  listBots,
  recordBotKnock,
  updateBotGrant,
} from "./bots";
import { upsertUser } from "./users";

/**
 * The bot registry, and the one property everything else is in service of:
 *
 * **a bot cannot widen what it is allowed to do.**
 *
 * Not by asking again, not by asking for more on a later join, and not by an
 * operator being handed a screen where "approve" means something bigger than
 * what was on it. The threat is a bot image that has been taken over between
 * the day it was approved and today.
 */

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-bots-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
});

after(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const BOT_A = "BOT_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOT_B = "BOT_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOT_C = "BOT_cccccccccccccccccccccccccccccccccccccccc";

describe("a bot is never mistaken for a person", () => {
  it("puts bots in their own tier, read off the id alone", () => {
    assert.equal(identityTierOf(BOT_A), "bot");
    assert.equal(identityTierOf("key:abc"), "local");
    assert.equal(identityTierOf("f81d4fae-7dec-11d0-a765-00a0c91e6bf6"), "account");
  });

  it("keeps the namespaces disjoint by shape", () => {
    assert.equal(isBotIdentity(BOT_A), true);
    assert.equal(isBotIdentity("key:abc"), false);
    assert.equal(isBotIdentity("bot_lowercase"), false, "the prefix is exact");
    assert.equal(isBotIdentity(null), false);
  });

  it("reserves bot-shaped names from people", () => {
    for (const name of ["BOT_helper", "bot-helper", "Bot Helper", "[BOT] Helper", "bot"]) {
      assert.equal(looksLikeABotName(name), true, name);
    }
    // And leaves alone the words that merely start the same way.
    for (const name of ["Robot", "Botany", "bottle", "Sivert", "botanist Sarah"]) {
      assert.equal(looksLikeABotName(name), false, name);
    }
  });
});

describe("a bot that knocks", () => {
  it("is recorded, pending, granted nothing", async () => {
    const { bot, created } = await recordBotKnock({
      botId: BOT_A,
      nickname: "Helper",
      description: "Answers questions",
      requestedPermissions: ["read_messages", "send_messages"],
    });

    assert.equal(created, true);
    assert.equal(bot.status, "pending");
    assert.deepEqual(bot.granted_permissions, []);
    assert.deepEqual(bot.requested_permissions.sort(), ["read_messages", "send_messages"]);
  });

  it("cannot change what it asked for by asking again", async () => {
    // The property this whole file exists for. A bot whose image has been taken
    // over comes back wanting the keys to the building; the answer it gets is
    // the question it asked the first time.
    const { bot, created } = await recordBotKnock({
      botId: BOT_A,
      nickname: "Helper But Evil Now",
      requestedPermissions: ["manage_roles", "ban_members", "manage_server"],
    });

    assert.equal(created, false);
    assert.deepEqual(bot.requested_permissions.sort(), ["read_messages", "send_messages"]);
    assert.equal(bot.nickname, "Helper", "and it cannot rename itself either");
  });

  it("gets only what the operator ticked", async () => {
    const decided = await decideBot(BOT_A, "approved", "user_owner", ["read_messages"], 0);
    assert.equal(decided?.status, "approved");
    assert.deepEqual(decided?.granted_permissions, ["read_messages"]);
  });

  it("cannot be granted something it never asked for", async () => {
    // Even from the operator's side. An approve screen somebody is clicking
    // through quickly must not be a blank cheque.
    const decided = await decideBot(
      BOT_A,
      "approved",
      "user_owner",
      ["read_messages", "manage_server", "ban_members"],
      0,
    );
    assert.deepEqual(decided?.granted_permissions, ["read_messages"]);
  });

  it("still cannot widen after approval", async () => {
    await recordBotKnock({
      botId: BOT_A,
      nickname: "Helper",
      requestedPermissions: ["manage_server"],
    });
    const bot = await getBotById(BOT_A);
    assert.equal(bot?.requested_permissions.includes("manage_server"), false);
    assert.deepEqual(bot?.granted_permissions, ["read_messages"]);
  });

  it("is denied with nothing granted", async () => {
    await recordBotKnock({
      botId: BOT_B,
      nickname: "Nope",
      requestedPermissions: ["send_messages"],
    });
    const denied = await decideBot(BOT_B, "denied", "user_owner", ["send_messages"], 0);
    assert.equal(denied?.status, "denied");
    assert.deepEqual(denied?.granted_permissions, []);
  });
});

describe("a registration written before the bot exists", () => {
  it("is claimed by the first identity to present the token", async () => {
    const reg = await createBotRegistration({
      nickname: "Deploybot",
      grantedPermissions: ["read_messages", "send_messages"],
      createdByServerUserId: "user_owner",
    });

    assert.equal(reg.status, "approved");
    assert.equal(reg.bot_id, null);
    assert.ok(reg.claim_token);

    const claimed = await claimBotRegistration(reg.claim_token!, BOT_C);
    assert.equal(claimed?.bot_id, BOT_C);
    assert.equal(claimed?.claim_token, null, "the token is spent");
    assert.deepEqual(claimed?.granted_permissions.sort(), ["read_messages", "send_messages"]);
  });

  it("cannot be claimed twice", async () => {
    const reg = await createBotRegistration({
      nickname: "Racer",
      grantedPermissions: ["read_messages"],
      createdByServerUserId: "user_owner",
    });
    const token = reg.claim_token!;

    const first = await claimBotRegistration(token, "BOT_dddddddddddddddddddddddddddddddddddddddd");
    const second = await claimBotRegistration(token, "BOT_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

    assert.ok(first, "the first one gets it");
    assert.equal(second, null, "the second is refused rather than sharing it");
  });
});

describe("what an approved bot can actually do", () => {
  it("holds its granted set and no role", async () => {
    const user = await upsertUser(BOT_C, "Deploybot");
    const standing = await getEffectiveStanding(user.server_user_id, BOT_C);

    assert.equal(standing.roleId, "bot");
    assert.equal(standing.isOwner, false);
    assert.equal(standing.permissions.has("read_messages"), true);
    assert.equal(standing.permissions.has("manage_server"), false);
  });

  it("cannot act on anybody at rank zero", async () => {
    // Kick, ban and mute all want a strictly higher rank than the target, so a
    // bot at zero can never reach a person however many permissions it holds.
    const user = await upsertUser(BOT_C, "Deploybot");
    const standing = await getEffectiveStanding(user.server_user_id, BOT_C);
    assert.equal(standing.rank, 0);
  });

  it("can be narrowed after the fact, but never widened past the ask", async () => {
    const reg = (await listBots()).find((b) => b.bot_id === BOT_C);
    assert.ok(reg);

    const narrowed = await updateBotGrant(reg.registration_id, ["read_messages"]);
    assert.deepEqual(narrowed?.granted_permissions, ["read_messages"]);

    const attempted = await updateBotGrant(reg.registration_id, ["read_messages", "manage_roles"]);
    assert.deepEqual(attempted?.granted_permissions, ["read_messages"]);
  });

  it("holds nothing once its registration is withdrawn", async () => {
    const reg = (await listBots()).find((b) => b.bot_id === BOT_C);
    assert.ok(reg);
    assert.equal(await deleteBotRegistration(reg.registration_id), true);

    const user = await upsertUser(BOT_C, "Deploybot");
    const standing = await getEffectiveStanding(user.server_user_id, BOT_C);
    // Not the joining default, not a role, not a fallback with anything in it.
    assert.deepEqual([...standing.permissions], []);
  });

  it("gets nothing while it is still pending", async () => {
    await recordBotKnock({
      botId: "BOT_ffffffffffffffffffffffffffffffffffffffff",
      nickname: "Waiting",
      requestedPermissions: ["send_messages"],
    });
    const user = await upsertUser("BOT_ffffffffffffffffffffffffffffffffffffffff", "Waiting");
    const standing = await getEffectiveStanding(
      user.server_user_id,
      "BOT_ffffffffffffffffffffffffffffffffffffffff",
    );
    assert.deepEqual([...standing.permissions], []);
  });
});
