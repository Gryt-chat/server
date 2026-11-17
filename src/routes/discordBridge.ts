/* eslint-disable @typescript-eslint/no-restricted-types -- the request body is outside input, checked field by field below */
import { ChannelType } from "discord.js";
import consola from "consola";
import express from "express";
import type { NextFunction, Request, Response } from "express";

import { clearDiscordBridge, getDiscordBridge, getUserByServerId, insertServerAudit, linkDiscordMember, listDiscordAuthors, listDiscordMemberLinks, saveDiscordBridgeApp, unlinkDiscordMember, grytChannelFor, listServerChannels, setDiscordChannelMatch, listExcludedFromBridge, setExcludedFromBridge, updateDiscordBridge, discordBridgeStats, discordPersonLinkedTo, listEmojis, SYNC_KINDS, type SyncKind } from "../db";
import { applicationIdForToken, inviteUrl, linkedGuild, pauseDiscordCopy, startDiscordBridge, startDiscordCopy, stopDiscordBridge } from "../discord/bridge";
import { emojiName } from "../import/discord/content";
import { isSnowflake } from "../import/discord/dce";
import { requireBearerToken } from "../middleware/requireBearerToken";
import { redeemLinkCode, removeDiscordPersonMessages } from "../discord/commands";
import { suggestMatches, type Side } from "../discord/match";
import { grantDiscordRoles } from "../discord/roles";
import { importedId } from "../import/discord/ids";
import { broadcastServerUiUpdate } from "../socket/utils/server";
import { requireOwner } from "./discordImport";

const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/** The token never leaves the server once it's pasted. */
function view() {
  const b = getDiscordBridge();
  if (!b) return { configured: false };
  return {
    configured: true,
    applicationId: b.application_id,
    status: b.status,
    guild: b.guild_id ? guildView(b.guild_id, b.guild_name) : null,
    inviteUrl: inviteUrl(b.application_id),
    direction: b.direction,
    copy: { status: b.copy_status, progress: b.copy_progress },
    syncNewChannels: b.sync_new_channels,
    excludedMembers: listExcludedFromBridge("gryt"),
    syncOff: b.sync_off,
    stats: b.copy_status === "idle" ? null : discordBridgeStats(),
  };
}

/** Name, icon and counts for the server card; only the name is known while the bot is away. */
function guildView(id: string, name: string | null) {
  const g = linkedGuild();
  if (!g || g.id !== id) return { id, name, icon: null, members: null, channels: null };
  const channels = g.channels.cache.filter((c) => TEXT_TYPES.has(c.type) || VOICE_TYPES.has(c.type)).size;
  return { id, name: g.name, icon: g.iconURL({ extension: "png", size: 128 }), members: g.memberCount, channels };
}

/** The roles they hold on Discord, the copied ones, given in the background; a link works without them. */
function giveDiscordRoles(discordUserId: string, serverUserId: string): void {
  const guild = linkedGuild();
  if (!guild) return;
  grantDiscordRoles(guild, discordUserId, serverUserId)
    .then((n) => {
      if (n > 0) broadcastServerUiUpdate("other");
    })
    .catch((e) => consola.warn("[DiscordBridge] couldn't give Discord roles", e));
}

export const discordBridgeRouter = express.Router();

discordBridgeRouter.use(requireBearerToken);
discordBridgeRouter.use((req, res, next) => {
  requireOwner(req, res, next).catch(next);
});

discordBridgeRouter.get("/", handle(async (_req, res) => {
  res.json(view());
}));

discordBridgeRouter.put("/", handle(async (req, res) => {
  const body = (req.body ?? {}) as { applicationId?: unknown; botToken?: unknown };
  const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  if (!isSnowflake(applicationId) || !botToken || botToken.length > 200) {
    res.status(400).json({ error: "invalid_payload", message: "Paste the application ID and the bot token from the Discord Developer Portal." });
    return;
  }
  const owner = await applicationIdForToken(botToken);
  if (!owner) {
    res.status(400).json({ error: "token_invalid", message: "Discord didn't accept that bot token. Reset it under Bot and paste the new one." });
    return;
  }
  if (owner !== applicationId) {
    res.status(400).json({ error: "app_mismatch", message: "That token belongs to a different application than the ID you pasted." });
    return;
  }
  saveDiscordBridgeApp(applicationId, botToken);
  void startDiscordBridge();
  res.json(view());
}));

const DIRECTIONS = new Set(["to_gryt", "both", "to_discord"]);

discordBridgeRouter.post("/copy", handle(async (req, res) => {
  const { direction, identity } = (req.body ?? {}) as { direction?: unknown; identity?: unknown };
  const serverUserId = req.tokenPayload?.serverUserId;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction) || !serverUserId) {
    res.status(400).json({ error: "invalid_payload", message: "Pick which way the bridge goes." });
    return;
  }
  if (getDiscordBridge()?.status !== "linked") {
    res.status(409).json({ error: "not_linked", message: "Add the bot to your Discord server first." });
    return;
  }
  startDiscordCopy(direction as "to_gryt" | "both" | "to_discord", serverUserId, identity === true);
  res.status(202).json(view());
}));

discordBridgeRouter.post("/copy/pause", handle(async (req, res) => {
  const paused = (req.body as { paused?: unknown } | undefined)?.paused;
  const status = getDiscordBridge()?.copy_status;
  if (typeof paused !== "boolean" || (status !== "running" && status !== "paused")) {
    res.status(409).json({ error: "not_copying" });
    return;
  }
  pauseDiscordCopy(paused);
  res.json(view());
}));

/** What "Before you start" asks about: whether this server already has a name, messages, and emoji that clash. */
discordBridgeRouter.get("/preview", handle(async (_req, res) => {
  const guild = linkedGuild();
  if (!guild) {
    res.status(409).json({ error: "not_linked", message: "Add the bot to your Discord server first." });
    return;
  }
  const mine = new Set((await listEmojis()).map((e) => e.name));
  const theirs = [...(await guild.emojis.fetch()).values()].map((e) => emojiName(e.name ?? undefined)).filter((n): n is string => !!n);
  const roles = (await guild.roles.fetch()).filter((r) => !r.managed && r.id !== guild.id).size;
  res.json({
    emoji: theirs.length,
    emojiClashes: theirs.filter((n) => mine.has(n)),
    roles,
  });
}));

/** Everyone whose messages came from Discord, and who they're linked to. */
discordBridgeRouter.get("/people", handle(async (_req, res) => {
  const links = new Map(listDiscordMemberLinks().map((l) => [l.discord_user_id, l]));
  const excluded = new Set(listExcludedFromBridge("discord"));
  const people = new Map<string, { name: string | null; avatar: string | null; messages: number }>();
  for (const a of listDiscordAuthors()) people.set(a.discord_user_id, { name: a.name, avatar: null, messages: a.messages });
  const guild = linkedGuild();
  if (guild) {
    try {
      for (const m of (await guild.members.fetch()).values()) {
        if (m.user.bot) continue;
        const known = people.get(m.id);
        people.set(m.id, { name: m.displayName, avatar: m.displayAvatarURL({ extension: "png", size: 64 }), messages: known?.messages ?? 0 });
      }
    } catch (e) {
      consola.warn("[DiscordBridge] couldn't list Discord members", e);
    }
  }
  res.json({
    people: [...people].map(([id, p]) => {
      const l = links.get(id);
      return { discordUserId: id, name: p.name, avatar: p.avatar, messages: p.messages, linkedTo: l?.server_user_id ?? null, proof: l?.proof ?? null, sync: !excluded.has(id) };
    }),
  });
}));

discordBridgeRouter.put("/people/:discordUserId", handle(async (req, res) => {
  const discordUserId = String(req.params.discordUserId);
  const serverUserId = (req.body as { serverUserId?: unknown } | undefined)?.serverUserId;
  const actor = req.tokenPayload?.serverUserId;
  if (!isSnowflake(discordUserId) || typeof serverUserId !== "string" || !actor || !(await getUserByServerId(serverUserId))) {
    res.status(400).json({ error: "invalid_payload", message: "Pick a member of this server to link." });
    return;
  }
  const taken = discordPersonLinkedTo(serverUserId);
  if (taken && taken !== discordUserId) {
    res.status(409).json({ error: "member_taken", message: "That member is already linked to someone else from Discord. Unlink them first." });
    return;
  }
  linkDiscordMember(discordUserId, serverUserId, actor, "admin");
  giveDiscordRoles(discordUserId, serverUserId);
  await insertServerAudit({ actorServerUserId: actor, action: "discord_link", target: serverUserId, meta: { discordUserId, proof: "admin" } });
  res.json({ ok: true });
}));

discordBridgeRouter.delete("/people/:discordUserId", handle(async (req, res) => {
  const discordUserId = String(req.params.discordUserId);
  const actor = req.tokenPayload?.serverUserId;
  if (!unlinkDiscordMember(discordUserId)) {
    res.status(404).json({ error: "not_linked" });
    return;
  }
  await insertServerAudit({ actorServerUserId: actor ?? null, action: "discord_unlink", target: discordUserId });
  res.json({ ok: true });
}));

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** The Discord server's channels, what each copies into now, and suggested matches for the ones with none. */
discordBridgeRouter.get("/channels", handle(async (_req, res) => {
  const guild = linkedGuild();
  if (!guild) {
    res.status(409).json({ error: "not_linked", message: "Add the bot to your Discord server first." });
    return;
  }
  const discord: (Side & { category: string | null })[] = [];
  for (const c of (await guild.channels.fetch()).values()) {
    if (!c) continue;
    let kind: Side["kind"] | null = null;
    if (TEXT_TYPES.has(c.type)) kind = "text";
    else if (VOICE_TYPES.has(c.type)) kind = "voice";
    if (kind) discord.push({ id: c.id, name: c.name, kind, category: c.parent?.name ?? null });
  }
  const gryt: Side[] = (await listServerChannels()).map((c) => ({ id: c.channel_id, name: c.name, kind: c.type === "voice" ? "voice" : "text" }));
  const suggested = suggestMatches(discord, gryt);
  res.json({
    gryt,
    discord: discord.map((d) => {
      const derived = importedId("channel", d.id);
      const current = grytChannelFor(d.id, derived);
      let target = current ?? "skip";
      if (current === derived) target = "new";
      return { ...d, target, suggested: target === "new" ? (suggested.get(d.id) ?? null) : null };
    }),
  });
}));

/** The owner's matches: "new", "skip" or a Gryt channel id each, one Discord channel per Gryt channel. */
discordBridgeRouter.put("/channels", handle(async (req, res) => {
  const matches = (req.body as { matches?: unknown } | undefined)?.matches;
  if (!Array.isArray(matches)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }
  const known = new Set((await listServerChannels()).map((c) => c.channel_id));
  const used = new Set<string>();
  const clean: { discordChannelId: string; target: string }[] = [];
  for (const m of matches as { discordChannelId?: unknown; target?: unknown }[]) {
    const id = typeof m?.discordChannelId === "string" ? m.discordChannelId : "";
    const target = typeof m?.target === "string" ? m.target : "";
    const ok = isSnowflake(id) && (target === "new" || target === "skip" || known.has(target));
    if (!ok || (target !== "new" && target !== "skip" && used.has(target))) {
      res.status(400).json({ error: "invalid_match", message: "Each Discord channel goes to one channel here, and one channel here takes one Discord channel." });
      return;
    }
    used.add(target);
    clean.push({ discordChannelId: id, target });
  }
  for (const m of clean) {
    setDiscordChannelMatch(m.discordChannelId, m.target === "skip" ? "skip" : { grytChannelId: m.target === "new" ? importedId("channel", m.discordChannelId) : m.target });
  }
  res.json({ ok: true });
}));

discordBridgeRouter.put("/settings", handle(async (req, res) => {
  const { syncNewChannels, syncOff } = (req.body ?? {}) as { syncNewChannels?: unknown; syncOff?: unknown };
  const kinds = Array.isArray(syncOff) ? syncOff.filter((k): k is SyncKind => (SYNC_KINDS as readonly unknown[]).includes(k)) : null;
  if ((syncNewChannels !== undefined && typeof syncNewChannels !== "boolean") || (syncOff !== undefined && !kinds) || (syncNewChannels === undefined && !kinds)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }
  updateDiscordBridge({
    ...(typeof syncNewChannels === "boolean" ? { sync_new_channels: syncNewChannels ? 1 : 0 } : {}),
    ...(kinds ? { sync_off: JSON.stringify([...new Set(kinds)]) } : {}),
  });
  res.json(view());
}));

/** Switch one person's sync on or off. Off for a Discord person can also remove what was already copied from them. */
discordBridgeRouter.put("/sync", handle(async (req, res) => {
  const body = (req.body ?? {}) as { kind?: unknown; id?: unknown; sync?: unknown; removeCopied?: unknown };
  const kind = body.kind === "discord" || body.kind === "gryt" ? body.kind : null;
  const id = typeof body.id === "string" ? body.id : "";
  if (!kind || !id || typeof body.sync !== "boolean" || (kind === "discord" && !isSnowflake(id))) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }
  setExcludedFromBridge(kind, id, !body.sync);
  const removed = kind === "discord" && !body.sync && body.removeCopied === true ? await removeDiscordPersonMessages(id) : 0;
  await insertServerAudit({ actorServerUserId: req.tokenPayload?.serverUserId ?? null, action: body.sync ? "discord_sync_on" : "discord_sync_off", target: id, meta: { kind, removed } });
  res.json({ ok: true, removed });
}));

discordBridgeRouter.delete("/", handle(async (_req, res) => {
  await stopDiscordBridge();
  clearDiscordBridge();
  res.json(view());
}));

/** For any member: a code from `/link` on the bot proves the Discord account is theirs. */
export const discordLinkRouter = express.Router();

discordLinkRouter.use(requireBearerToken);

discordLinkRouter.post("/", handle(async (req, res) => {
  const code = (req.body as { code?: unknown } | undefined)?.code;
  const serverUserId = req.tokenPayload?.serverUserId;
  const pending = typeof code === "string" && serverUserId ? redeemLinkCode(code) : null;
  if (!pending || !serverUserId) {
    res.status(400).json({ error: "invalid_code", message: "That code didn't work. Run /link on Discord again for a new one." });
    return;
  }
  linkDiscordMember(pending.discordUserId, serverUserId, serverUserId, "code");
  giveDiscordRoles(pending.discordUserId, serverUserId);
  await insertServerAudit({ actorServerUserId: serverUserId, action: "discord_link", target: serverUserId, meta: { discordUserId: pending.discordUserId, proof: "code" } });
  res.json({ discordName: pending.discordName });
}));
