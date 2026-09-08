import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { initSqlite } from "../db/sqlite/connection";
import { listServerAudit } from "../db/sqlite/invites";
import { createRoleDefinition } from "../db/sqlite/roleDefinitions";
import {
  createServerConfigIfNotExists,
  getActiveBan,
  isUserBanned,
  setServerOwner,
  setServerRole,
} from "../db/sqlite/servers";
import { upsertServerChannel } from "../db/sqlite/channels";
import { getMessageById, insertMessage } from "../db/sqlite/messages";
import { getUserByServerId, setUserInactive, upsertUser } from "../db/sqlite/users";
import { resetChannelIdCache } from "../socket/utils/conversationAccess";
import { getMessagesCached, resetMessageCache } from "../socket/utils/messageCache";
import { resetRateLimits } from "../utils/rateLimiter";
import type { Clients } from "../types";
import {
  PLUGIN_ACTION_RULE,
  createModerationActions,
  pluginActorId,
} from "./actions";
import { clearPluginRefs, setPluginRefs } from "./refs";

/**
 * The kick is `evictUser`, tested where it lives. Here are the three checks
 * around it: no rank to compare, no ceiling, and no name for the audit row.
 */

let dir: string;

/* An empty socket map, since the decision is what is tested. `to` and `emit`
   are stubbed because the debounced broadcast fires after the case ends. */
const io = {
  sockets: { sockets: new Map() },
  to: () => ({ emit: () => {} }),
  emit: () => {},
} as never;
const clientsInfo: Clients = {};

const refs = () => ({ io, serverId: "test-server", clientsInfo, sfuClient: null });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gryt-plugin-actions-"));
  process.env.DATA_DIR = dir;
  await initSqlite();
  await createServerConfigIfNotExists();

  await createRoleDefinition("moderator", {
    name: "Moderator",
    rank: 50,
    permissions: ["send_messages", "kick_members"],
  });
  await createRoleDefinition("regular", {
    name: "Regular",
    rank: 10,
    permissions: ["send_messages"],
  });
});

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  resetRateLimits();
  resetMessageCache();
  setPluginRefs(refs());
});

let seq = 0;

async function channel(): Promise<string> {
  seq += 1;
  const channelId = `channel-${seq}`;
  await upsertServerChannel({ channelId, name: `Channel ${seq}`, type: "text" });
  resetChannelIdCache();
  return channelId;
}

async function post(channelId: string, senderServerUserId: string, text: string) {
  return insertMessage({
    conversation_id: channelId,
    sender_server_id: senderServerUserId,
    text,
    sealed: null,
    attachments: null,
    reactions: null,
    reply_to_message_id: null,
    thread_id: null,
  });
}

async function member(role = "regular") {
  seq += 1;
  const user = await upsertUser(`account-member-${seq}`, `Member ${seq}`);
  await setServerRole(user.server_user_id, role);
  return user;
}

describe("kicking an ordinary member", () => {
  it("takes them off the server", async () => {
    const target = await member();
    const result = await createModerationActions("automod").kick(target.server_user_id);

    assert.deepEqual(result, { ok: true });
    assert.equal((await getUserByServerId(target.server_user_id))?.is_active, false);
  });

  it("does not ban them", async () => {
    const target = await member();
    await createModerationActions("automod").kick(target.server_user_id);

    assert.equal(await isUserBanned(target.gryt_user_id), false);
  });
});

describe("banning", () => {
  it("stops them coming back", async () => {
    const target = await member();
    const result = await createModerationActions("automod").ban(target.server_user_id, {
      reason: "posting the same link in every channel",
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(await isUserBanned(target.gryt_user_id), true);
  });

  it("keeps the reason", async () => {
    const target = await member();
    await createModerationActions("automod").ban(target.server_user_id, { reason: "spam" });

    assert.equal((await getActiveBan(target.gryt_user_id))?.reason, "spam");
  });

  it("is permanent unless a duration is given", async () => {
    const target = await member();
    await createModerationActions("automod").ban(target.server_user_id);

    assert.equal((await getActiveBan(target.gryt_user_id))?.expires_at, null);
  });

  it("expires when one is", async () => {
    const target = await member();
    await createModerationActions("automod").ban(target.server_user_id, { durationMs: 60_000 });

    const ban = await getActiveBan(target.gryt_user_id);
    assert.ok(ban?.expires_at);
    const ms = ban.expires_at.getTime() - Date.now();
    assert.ok(ms > 50_000 && ms <= 60_000, `expected about a minute, got ${ms}ms`);
  });

  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`is permanent rather than already expired for a duration of ${durationMs}`, async () => {
      const target = await member();
      await createModerationActions("automod").ban(target.server_user_id, { durationMs });

      assert.equal(
        (await getActiveBan(target.gryt_user_id))?.expires_at,
        null,
        "a nonsense duration produced a ban that was over before it started",
      );
    });
  }
});

/* The ban list joins `banned_by_server_user_id` against `users` for a name, so
   a plugin leaves it empty rather than borrowing somebody's. */
describe("who it says did it", () => {
  it("writes the plugin, not a person, on the ban", async () => {
    const target = await member();
    await createModerationActions("automod").ban(target.server_user_id);

    const ban = await getActiveBan(target.gryt_user_id);
    assert.equal(ban?.banned_by_server_user_id, "plugin:automod");
    assert.equal(ban?.banned_by_nickname, null, "a member's name was attached to a plugin's ban");
  });

  it("writes an action a human never writes", async () => {
    const target = await member();
    await createModerationActions("automod").kick(target.server_user_id);

    const [entry] = await listServerAudit(1);
    assert.equal(entry.action, "plugin:kick", "a plugin's kick reads as a person's in the audit log");
    assert.equal(entry.actor_server_user_id, pluginActorId("automod"));
    assert.equal(entry.target, target.server_user_id);
  });

  it("names the plugin in the audit meta as well as the actor", async () => {
    const target = await member();
    await createModerationActions("automod").ban(target.server_user_id, { reason: "spam" });

    const [entry] = await listServerAudit(1);
    assert.equal(entry.action, "plugin:ban");
    assert.deepEqual(JSON.parse(entry.meta_json ?? "{}"), { plugin: "automod", reason: "spam" });
  });

  it("tells two plugins apart", async () => {
    const first = await member();
    const second = await member();
    await createModerationActions("automod").kick(first.server_user_id);
    await createModerationActions("welcomer").kick(second.server_user_id);

    const entries = await listServerAudit(2);
    assert.deepEqual(
      entries.map((e) => e.actor_server_user_id).sort(),
      ["plugin:automod", "plugin:welcomer"],
    );
  });
});

/* `reach.ts` holds the rule and is tested on its own; these two reach it
   through a real database. */
describe("who it cannot touch", () => {
  it("refuses the owner", async () => {
    const owner = await upsertUser("account-owner", "Owner");
    await setServerOwner("account-owner");

    const result = await createModerationActions("automod").ban(owner.server_user_id);

    assert.equal(result.ok, false);
    assert.equal(await isUserBanned(owner.gryt_user_id), false);
  });

  it("refuses a moderator", async () => {
    const mod = await member("moderator");
    const result = await createModerationActions("automod").kick(mod.server_user_id);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /moderator/);
    assert.equal((await getUserByServerId(mod.server_user_id))?.is_active, true);
  });

  it("writes no audit row for a refusal", async () => {
    const mod = await member("moderator");
    const before = (await listServerAudit(200)).length;

    await createModerationActions("automod").kick(mod.server_user_id);

    assert.equal((await listServerAudit(200)).length, before);
  });
});

describe("a target that is not there", () => {
  it("refuses an id nobody has", async () => {
    const result = await createModerationActions("automod").kick("user_nobody");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /no member/);
  });

  for (const junk of ["", "   "]) {
    it(`refuses ${JSON.stringify(junk)}`, async () => {
      const result = await createModerationActions("automod").kick(junk);
      assert.equal(result.ok, false);
    });
  }

  /* A plugin reacting to member:left by kicking would otherwise loop, writing
     an audit row every time round. */
  it("refuses somebody who has already gone", async () => {
    const target = await member();
    await setUserInactive(target.server_user_id);

    const result = await createModerationActions("automod").kick(target.server_user_id);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /not on this server/);
  });
});

/* Against a loop rather than a hostile plugin, which has the Node runtime and
   does not need this API. */
describe("a plugin that will not stop", () => {
  it("is cut off at the limit", async () => {
    const actions = createModerationActions("runaway");
    const targets = [];
    for (let i = 0; i < PLUGIN_ACTION_RULE.limit + 3; i++) targets.push(await member());

    const results = [];
    for (const target of targets) results.push(await actions.kick(target.server_user_id));

    const allowed = results.filter((r) => r.ok).length;
    assert.ok(
      allowed <= PLUGIN_ACTION_RULE.limit,
      `${allowed} actions got through a limit of ${PLUGIN_ACTION_RULE.limit}`,
    );
    assert.ok(allowed > 0, "the limit refused everything, including the first");
    const last = results[results.length - 1];
    assert.equal(last.ok, false);
    assert.match(last.ok === false ? last.reason : "", /too many/);
  });

  it("does not take the other plugins down with it", async () => {
    const runaway = createModerationActions("runaway");
    for (let i = 0; i < PLUGIN_ACTION_RULE.limit + 3; i++) {
      await runaway.kick((await member()).server_user_id);
    }

    const target = await member();
    const result = await createModerationActions("wellbehaved").kick(target.server_user_id);

    assert.deepEqual(result, { ok: true }, "the limit is shared between plugins rather than per plugin");
  });
});

/* Plugins load before the first connection, so one acting from an import-time
   timer would otherwise reach a null `io`. */
describe("before the socket layer is up", () => {
  it("refuses rather than throwing", async () => {
    clearPluginRefs();
    const target = await member();

    const result = await createModerationActions("early").kick(target.server_user_id);

    assert.equal(result.ok, false);
    assert.equal((await getUserByServerId(target.server_user_id))?.is_active, true);
  });
});

/* The same delete `chat:delete` does, attachment cleanup and cache drop
   included — the half a second copy would have gone quietly missing. */
describe("deleting a message", () => {
  it("takes it out of the database", async () => {
    const c = await channel();
    const author = await member();
    const msg = await post(c, author.server_user_id, "buy my coins");

    const result = await createModerationActions("automod").deleteMessage(c, msg.message_id);

    assert.deepEqual(result, { ok: true });
    assert.equal(await getMessageById(c, msg.message_id), null);
  });

  /* A delete that updates the row and not the cache leaves the message on the
     next person's first page. */
  it("takes it out of the cache as well", async () => {
    const c = await channel();
    const author = await member();
    const msg = await post(c, author.server_user_id, "buy my coins");
    await post(c, author.server_user_id, "something else");
    await getMessagesCached(c);

    await createModerationActions("automod").deleteMessage(c, msg.message_id);

    assert.deepEqual(
      (await getMessagesCached(c)).map((m) => m.text),
      ["something else"],
      "the deleted message was still on the cached first page",
    );
  });

  it("records who did it, and which message", async () => {
    const c = await channel();
    const author = await member();
    const msg = await post(c, author.server_user_id, "buy my coins");

    await createModerationActions("automod").deleteMessage(c, msg.message_id);

    const [entry] = await listServerAudit(1);
    assert.equal(entry.action, "plugin:message:delete");
    assert.equal(entry.actor_server_user_id, "plugin:automod");
    assert.equal(entry.target, c);
    assert.deepEqual(JSON.parse(entry.meta_json ?? "{}"), {
      plugin: "automod",
      messageId: msg.message_id,
      author: author.server_user_id,
    });
  });

  it("refuses a message that is not there", async () => {
    const c = await channel();
    const result = await createModerationActions("automod").deleteMessage(c, "never-existed");

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /no message/);
  });

  /* The same rule that keeps DMs out of `message:created`. Asks whether the id
     is a channel, so one that is neither is refused too. */
  it("refuses anything that is not a channel", async () => {
    const author = await member();
    const msg = await post("conversation-not-a-channel", author.server_user_id, "private");

    const result = await createModerationActions("automod")
      .deleteMessage("conversation-not-a-channel", msg.message_id);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /direct messages/);
    assert.ok(await getMessageById("conversation-not-a-channel", msg.message_id));
  });

  /* Quieter than banning them and the same kind of thing. A plugin that could
     do this could delete every message a moderator posted about the plugin. */
  it("refuses to delete a moderator's message", async () => {
    const c = await channel();
    const mod = await member("moderator");
    const msg = await post(c, mod.server_user_id, "I am watching this plugin");

    const result = await createModerationActions("automod").deleteMessage(c, msg.message_id);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /moderator/);
    assert.ok(await getMessageById(c, msg.message_id));
  });

  it("still deletes a message whose author has since left", async () => {
    const c = await channel();
    const author = await member();
    const msg = await post(c, author.server_user_id, "spam, then gone");
    await setUserInactive(author.server_user_id);

    const result = await createModerationActions("automod").deleteMessage(c, msg.message_id);

    assert.deepEqual(result, { ok: true }, "a spammer leaving should not strand their spam");
  });

  /* Everything below would refuse these anyway; what this holds is the message.
     "no channel with that id" for an empty string sends somebody hunting. */
  for (const [channelId, messageId] of [["", "m"], ["c", ""], ["  ", "m"], ["c", "  "]]) {
    it(`refuses ${JSON.stringify([channelId, messageId])}, saying which`, async () => {
      const result = await createModerationActions("automod").deleteMessage(channelId, messageId);
      assert.equal(result.ok, false);
      assert.match(
        result.ok === false ? result.reason : "",
        /a channel id and a message id are both needed/,
      );
    });
  }

  it("counts against the same ceiling as kicking", async () => {
    const c = await channel();
    const author = await member();
    const actions = createModerationActions("busy");

    for (let i = 0; i < PLUGIN_ACTION_RULE.limit; i++) {
      await actions.kick((await member()).server_user_id);
    }

    const msg = await post(c, author.server_user_id, "one too many");
    const result = await actions.deleteMessage(c, msg.message_id);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /too many/);
  });

  it("refuses before the socket layer is up", async () => {
    clearPluginRefs();
    const c = await channel();
    const author = await member();
    const msg = await post(c, author.server_user_id, "early");

    const result = await createModerationActions("early").deleteMessage(c, msg.message_id);

    assert.equal(result.ok, false);
    assert.ok(await getMessageById(c, msg.message_id));
  });
});
