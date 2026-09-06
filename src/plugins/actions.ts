/**
 * The things a plugin can do to somebody (GRYT-935).
 *
 * Stage one gave plugins events and nothing else, which is enough for a
 * summariser and not enough for the thing people actually want: an automod
 * that removes somebody who is being malicious. This is that, for kicking and
 * banning. Deleting a message is GRYT-936 — `chat:delete` does six things
 * inline and needs pulling out before a second caller can have it.
 *
 * Nothing here is new moderation. It calls `evictUser`, the same module the
 * socket handlers call, so a plugin's kick and a moderator's kick are the same
 * kick. What is new is the three checks around it, because a plugin has none
 * of what a moderator's request carries:
 *
 * 1. **Who it may act on.** A plugin holds no role, so the rank comparison
 *    every human path uses has nothing to compare. `pluginMayActOn` takes its
 *    place: a plugin cannot act on a moderator or the owner.
 * 2. **How often.** Not against abuse from outside — the plugin is already
 *    inside. Against a loop. A plugin with a bug that bans everybody who
 *    speaks is a plausible Tuesday, and a ceiling with a loud log is the
 *    difference between losing five members and losing the server.
 * 3. **Who it was.** A ban row and an audit row both want an actor, and a
 *    plugin is not a member. Attributing it to one would be a lie in the one
 *    record that exists to answer "who did this".
 */

import consola from "consola";
import { banUser, getMessageById, getUserByServerId, insertServerAudit } from "../db";
import { channelExists } from "../socket/utils/conversationAccess";
import { deleteMessageEverywhere } from "../moderation/deleteMessage";
import { evictUser } from "../moderation/evict";
import { getEffectiveStanding } from "../services/permissions";
import { broadcastMemberList, syncAllClients } from "../socket/utils/clients";
import { checkRateLimit, type RateLimitRule } from "../utils/rateLimiter";
import { pluginRefs } from "./refs";
import { pluginMayActOn } from "./reach";

/**
 * A ceiling on a runaway plugin, not a defence against a hostile one.
 *
 * A plugin that means harm has the Node runtime and does not need this API. So
 * the number is chosen against the accident: twenty in a minute is far more
 * than any real automod does on a normal day, and far fewer than a loop
 * manages before somebody notices.
 */
export const PLUGIN_ACTION_RULE: RateLimitRule = {
  limit: 20,
  windowMs: 60_000,
  scorePerAction: 2,
  maxScore: 10,
  scoreDecayMs: 5_000,
};

/**
 * The actor written to the ban row and the audit row.
 *
 * A plugin has no `server_user_id`, and the ban list joins that column against
 * `users` for a name — so this leaves `banned_by_nickname` null rather than
 * borrowing a member's. That is the point: an operator reading the ban list
 * must not be told a person did something a plugin did. The id itself carries
 * which plugin, for anybody reading the rows.
 */
export function pluginActorId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export type ModerationOutcome =
  | { ok: true }
  /**
   * Returned rather than thrown. A refusal here is an ordinary answer — the
   * member is a moderator, or already gone, or the plugin has done twenty of
   * these in a minute — and a plugin should be able to log it and carry on.
   * Throwing would count towards the bus's disable threshold and take a
   * working plugin off the air for asking a reasonable question.
   */
  | { ok: false; reason: string };

export interface PluginModeration {
  /**
   * Remove somebody from the server. They can come back.
   *
   * @param serverUserId The member's id on this server, as carried by every event.
   */
  kick(serverUserId: string, options?: { reason?: string }): Promise<ModerationOutcome>;
  /**
   * Remove somebody and stop them returning.
   *
   * @param options.durationMs Omit for permanent.
   */
  ban(
    serverUserId: string,
    options?: { reason?: string; durationMs?: number },
  ): Promise<ModerationOutcome>;
  /**
   * Take a message down. Usually the more proportionate answer — most spam
   * wants the post gone rather than the person.
   *
   * Channels only. A direct message is between two people and a plugin the
   * operator installed has no business in it, the same rule that keeps DMs out
   * of `message:created`.
   *
   * @param channelId The `channelId` carried on `message:created`.
   */
  deleteMessage(channelId: string, messageId: string): Promise<ModerationOutcome>;
}

async function act(
  pluginId: string,
  action: "kick" | "ban",
  serverUserId: string,
  options: { reason?: string; durationMs?: number },
): Promise<ModerationOutcome> {
  const refs = pluginRefs();
  if (!refs) {
    return { ok: false, reason: "the server is not accepting connections yet" };
  }

  if (typeof serverUserId !== "string" || serverUserId.trim() === "") {
    return { ok: false, reason: "no member id was given" };
  }
  const targetId = serverUserId.trim();

  const rl = checkRateLimit("plugin:moderation", pluginId, undefined, PLUGIN_ACTION_RULE);
  if (!rl.allowed) {
    /* Loud, because the interesting case is not one refusal — it is a plugin
       that has started looping and will hit this on every message from here on. */
    consola.warn(
      `plugin ${pluginId} hit its moderation limit and its ${action} was refused; ` +
        `${PLUGIN_ACTION_RULE.limit} actions a minute is a ceiling on a loop, not a quota to raise`,
    );
    return { ok: false, reason: "too many moderation actions from this plugin" };
  }

  const target = await getUserByServerId(targetId);
  if (!target) {
    return { ok: false, reason: "no member with that id" };
  }
  /* Somebody already gone. Worth refusing rather than doing again: a plugin
     reacting to `member:left` and kicking is a loop that would otherwise write
     an audit row every time round. */
  if (!target.is_active) {
    return { ok: false, reason: "that member is not on this server" };
  }

  const standing = await getEffectiveStanding(targetId, target.gryt_user_id);
  const reach = pluginMayActOn(standing);
  if (!reach.allowed) {
    return { ok: false, reason: reach.reason };
  }

  const reason = typeof options.reason === "string" ? options.reason.slice(0, 500) : undefined;
  const actor = pluginActorId(pluginId);

  /* The ban row goes in before the eviction, matching the socket handler:
     evicting first leaves a window where they reconnect before the ban lands. */
  if (action === "ban") {
    const expiresAt =
      typeof options.durationMs === "number" && Number.isFinite(options.durationMs) && options.durationMs > 0
        ? new Date(Date.now() + options.durationMs)
        : null;
    await banUser(target.gryt_user_id, actor, reason, expiresAt);
  }

  await evictUser({
    io: refs.io,
    clientsInfo: refs.clientsInfo,
    serverId: refs.serverId,
    sfuClient: refs.sfuClient,
    targetServerUserId: targetId,
    targetGrytUserId: target.gryt_user_id,
    action,
    reason,
  });

  /*
   * A distinct action string rather than the same "kick" a person writes. An
   * audit row that reads like a human did it, when a plugin did, is the exact
   * failure the actor field exists to prevent — and the operator scanning for
   * "what has this plugin been doing" can grep one prefix.
   */
  await insertServerAudit({
    actorServerUserId: actor,
    action: `plugin:${action}`,
    target: targetId,
    meta: { plugin: pluginId, reason: reason ?? null },
  }).catch((e) => consola.warn("audit log write failed", e));

  syncAllClients(refs.io, refs.clientsInfo);
  broadcastMemberList(refs.io, refs.clientsInfo, refs.serverId);

  consola.info(`plugin ${pluginId} ${action}ed ${targetId}${reason ? `: ${reason}` : ""}`);
  return { ok: true };
}

async function remove(
  pluginId: string,
  channelId: string,
  messageId: string,
): Promise<ModerationOutcome> {
  const refs = pluginRefs();
  if (!refs) {
    return { ok: false, reason: "the server is not accepting connections yet" };
  }
  if (typeof channelId !== "string" || typeof messageId !== "string" || !channelId.trim() || !messageId.trim()) {
    return { ok: false, reason: "a channel id and a message id are both needed" };
  }

  const rl = checkRateLimit("plugin:moderation", pluginId, undefined, PLUGIN_ACTION_RULE);
  if (!rl.allowed) {
    consola.warn(
      `plugin ${pluginId} hit its moderation limit and its delete was refused; ` +
        `${PLUGIN_ACTION_RULE.limit} actions a minute is a ceiling on a loop, not a quota to raise`,
    );
    return { ok: false, reason: "too many moderation actions from this plugin" };
  }

  /*
   * Channels only, established by asking whether this is one rather than by
   * asking whether it is a DM. A conversation id that is neither is refused for
   * the same reason: `deleteMessageEverywhere` is told this is a channel, and
   * it decides who to notify from that.
   */
  if (!(await channelExists(channelId.trim()))) {
    return { ok: false, reason: "no channel with that id — plugins cannot touch direct messages" };
  }

  const message = await getMessageById(channelId.trim(), messageId.trim());
  if (!message) {
    return { ok: false, reason: "no message with that id in that channel" };
  }

  /*
   * The same reach rule as kicking, applied to whoever wrote it. Deleting a
   * moderator's message is acting on a moderator — quieter than banning them
   * and the same kind of thing, and a plugin that could do it could delete
   * every message a moderator posted about the plugin.
   */
  const author = await getUserByServerId(message.sender_server_id);
  if (author) {
    const reach = pluginMayActOn(await getEffectiveStanding(author.server_user_id, author.gryt_user_id));
    if (!reach.allowed) {
      return { ok: false, reason: reach.reason };
    }
  }

  const deleted = await deleteMessageEverywhere({
    io: refs.io,
    clientsInfo: refs.clientsInfo,
    sfuClient: refs.sfuClient,
    conversationId: channelId.trim(),
    messageId: messageId.trim(),
    message,
    access: { allowed: true, kind: "channel" },
  });

  if (!deleted) {
    return { ok: false, reason: "the message was already gone" };
  }

  await insertServerAudit({
    actorServerUserId: pluginActorId(pluginId),
    action: "plugin:message:delete",
    target: channelId.trim(),
    meta: { plugin: pluginId, messageId: messageId.trim(), author: message.sender_server_id },
  }).catch((e) => consola.warn("audit log write failed", e));

  consola.info(`plugin ${pluginId} deleted message ${messageId.trim()} in ${channelId.trim()}`);
  return { ok: true };
}

export function createModerationActions(pluginId: string): PluginModeration {
  return {
    kick: (serverUserId, options = {}) => act(pluginId, "kick", serverUserId, options),
    ban: (serverUserId, options = {}) => act(pluginId, "ban", serverUserId, options),
    deleteMessage: (channelId, messageId) => remove(pluginId, channelId, messageId),
  };
}
