/**
 * Calls `evictUser`, so a plugin's kick is a moderator's kick. What is added is
 * who it may act on, how often, and an actor that is not a member.
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

/** Against a loop, not a hostile plugin, which has the Node runtime anyway.
    More than a real automod does, fewer than a loop manages unnoticed. */
export const PLUGIN_ACTION_RULE: RateLimitRule = {
  limit: 20,
  windowMs: 60_000,
  scorePerAction: 2,
  maxScore: 10,
  scoreDecayMs: 5_000,
};

/** Leaves `banned_by_nickname` null rather than borrowing a member's: the ban
    list must not say a person did what a plugin did. */
export function pluginActorId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export type ModerationOutcome =
  | { ok: true }
  /** Returned, not thrown: a refusal is an ordinary answer, and throwing counts
      towards the bus's disable threshold. */
  | { ok: false; reason: string };

export interface PluginModeration {
  /** Remove somebody from the server. They can come back.
      @param serverUserId The member's id, as carried by every event. */
  kick(serverUserId: string, options?: { reason?: string }): Promise<ModerationOutcome>;
  /** Remove somebody and stop them returning.
      @param options.durationMs Omit for permanent. */
  ban(
    serverUserId: string,
    options?: { reason?: string; durationMs?: number },
  ): Promise<ModerationOutcome>;
  /** Channels only, the same rule that keeps DMs out of `message:created`.
      @param channelId The `channelId` carried on that event. */
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
  /* Already gone. A plugin reacting to `member:left` by kicking is a loop that
     would write an audit row every time round. */
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

  /* A distinct action string, so an audit row never reads as a human doing what
     a plugin did, and one prefix greps a plugin's whole history. */
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

  /* Asks whether this is a channel rather than whether it is a DM, because
     `deleteMessageEverywhere` decides who to notify from being told it is. */
  if (!(await channelExists(channelId.trim()))) {
    return { ok: false, reason: "no channel with that id — plugins cannot touch direct messages" };
  }

  const message = await getMessageById(channelId.trim(), messageId.trim());
  if (!message) {
    return { ok: false, reason: "no message with that id in that channel" };
  }

  /* The same reach rule as kicking: a plugin that could delete a moderator's
     message could delete every message a moderator posted about the plugin. */
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
