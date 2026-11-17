import consola from "consola";
import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, REST, Routes, type Guild } from "discord.js";

import { getDiscordBridge, updateDiscordBridge, type DiscordBridgeDirection, type DiscordBridgeStatus } from "../db";
import type { ImportMedia } from "../import/discord/importer";
import { resetMessageCache } from "../socket/utils/messageCache";
import { attachCommands, registerCommands } from "./commands";
import { copyGuild } from "./copy";
import { attachLayoutSync } from "./layout";
import { attachLiveSync } from "./live";
import { setOutboundClient } from "./outbound";
import { attachPresence } from "./presence";

/** Read, write with each member's name and picture, mirror pins, reactions and threads. Not Administrator. */
export const BRIDGE_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.CreatePublicThreads |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.PinMessages |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.EmbedLinks;

export function inviteUrl(applicationId: string): string {
  const q = new URLSearchParams({ client_id: applicationId, scope: "bot applications.commands", permissions: BRIDGE_PERMISSIONS.toString() });
  return `https://discord.com/oauth2/authorize?${q.toString()}`;
}

/** Gateway close codes that won't fix themselves by reconnecting. */
export function statusForCloseCode(code: number): DiscordBridgeStatus | null {
  if (code === 4004) return "token_invalid";
  if (code === 4014) return "intents_missing";
  return null;
}

/** Answers the application id the token belongs to, or null when Discord refuses it. */
export async function applicationIdForToken(botToken: string): Promise<string | null> {
  try {
    const app = (await new REST().setToken(botToken).get(Routes.currentApplication())) as { id?: string };
    return typeof app.id === "string" ? app.id : null;
  } catch {
    return null;
  }
}

const CLAIM = /\s*\(gryt:([0-9a-f-]{36})\)/;

/** The Gryt server an app's description says it belongs to, if any. */
export function claimIn(description: string | null | undefined): string | null {
  return CLAIM.exec(description ?? "")?.[1] ?? null;
}

/** One app per Gryt server: two servers on one bot would each leave the other's Discord server and copy each other's posts.
    The claim lives in the app's description, the one place every Gryt server using the token can read. */
export async function claimApplication(botToken: string, claimId: string): Promise<"ok" | "taken"> {
  const rest = new REST().setToken(botToken);
  const app = (await rest.get(Routes.currentApplication())) as { description?: string };
  const current = claimIn(app.description);
  if (current && current !== claimId) return "taken";
  if (current === claimId) return "ok";
  const description = `${(app.description ?? "").slice(0, 340)} (gryt:${claimId})`.trim();
  await rest.patch(Routes.currentApplication(), { body: { description } }).catch((e) => consola.warn("[DiscordBridge] couldn't write the claim", e));
  return "ok";
}

/** Unlinking hands the app back, so another Gryt server can use it. */
export async function releaseApplication(botToken: string, claimId: string | null): Promise<void> {
  if (!claimId) return;
  const rest = new REST().setToken(botToken);
  const app = (await rest.get(Routes.currentApplication())) as { description?: string };
  if (claimIn(app.description) !== claimId) return;
  await rest.patch(Routes.currentApplication(), { body: { description: (app.description ?? "").replace(CLAIM, "").trim() } });
}

let client: Client | null = null;

/** The logged-in bot, or null. Outbound sync checks this rather than assuming a connection. */
export function bridgeClient(): Client | null {
  return client?.isReady() ? client : null;
}
setOutboundClient(bridgeClient);

/** The Discord server the bot is linked to, once it's in it. */
export function linkedGuild(): Guild | null {
  const id = getDiscordBridge()?.guild_id;
  return (id && client?.guilds.cache.get(id)) || null;
}
let media: ImportMedia | null = null;
let copying = false;

/** Runs once at a time; a copy cut off by a restart is picked up when the bot is back in its server. */
async function runCopy(): Promise<void> {
  const b = getDiscordBridge();
  const guild = b?.guild_id ? client?.guilds.cache.get(b.guild_id) : undefined;
  if (copying || !b || !guild || !media || b.copy_status !== "running" || !b.copy_started_by) return;
  copying = true;
  try {
    const progress = await copyGuild(guild, {
      media,
      startedBy: b.copy_started_by,
      identity: b.copy_identity,
      onProgress: (p) => updateDiscordBridge({ copy_progress: JSON.stringify(p) }),
      stopped: () => getDiscordBridge()?.copy_status !== "running",
    });
    if (getDiscordBridge()?.copy_status === "running") updateDiscordBridge({ copy_status: "done", copy_progress: JSON.stringify(progress), copy_identity: 0 });
  } catch (e) {
    consola.error("[DiscordBridge] copy failed", e);
    updateDiscordBridge({ copy_status: "failed" });
  } finally {
    copying = false;
    resetMessageCache();
  }
}

export function startDiscordCopy(direction: DiscordBridgeDirection, startedBy: string, identity: boolean): void {
  updateDiscordBridge({ direction, copy_status: "running", copy_started_by: startedBy, copy_identity: identity ? 1 : 0 });
  void runCopy();
}

/** Pausing stops between pages; resuming picks up each channel where it stopped. */
export function pauseDiscordCopy(paused: boolean): void {
  updateDiscordBridge({ copy_status: paused ? "paused" : "running" });
  if (!paused) void runCopy();
}

function setStatus(status: DiscordBridgeStatus, guild?: Guild | null): void {
  updateDiscordBridge({ status, ...(guild !== undefined ? { guild_id: guild?.id ?? null, guild_name: guild?.name ?? null } : {}) });
}

/** One Discord server per Gryt server: the first one the bot is in stays, any other is left. */
async function settleGuild(c: Client): Promise<void> {
  const linked = getDiscordBridge()?.guild_id ?? null;
  const guilds = [...c.guilds.cache.values()];
  const keep = guilds.find((g) => g.id === linked) ?? (linked ? undefined : guilds[0]);
  for (const g of guilds) {
    if (g.id !== keep?.id) await g.leave().catch((e) => consola.warn(`[DiscordBridge] couldn't leave ${g.id}`, e));
  }
  if (keep) {
    setStatus("linked", keep);
    void registerCommands(keep);
    void runCopy();
  }
  else setStatus(linked ? "removed" : "waiting_for_invite");
}

export async function startDiscordBridge(store?: ImportMedia): Promise<void> {
  if (store) media = store;
  await stopDiscordBridge();
  const config = getDiscordBridge();
  if (!config) return;

  const c = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
    // Edits, deletes and reactions on messages from before the bot started arrive as partials.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
  client = c;
  if (media) attachLiveSync(c, media);
  attachCommands(c);
  attachLayoutSync(c);
  attachPresence(c);
  c.once(Events.ClientReady, () => void settleGuild(c));
  c.on(Events.GuildCreate, () => void settleGuild(c));
  c.on(Events.GuildDelete, (g) => {
    if (g.id === getDiscordBridge()?.guild_id) setStatus("removed");
  });
  c.on(Events.ShardDisconnect, (event) => {
    const status = statusForCloseCode(event.code);
    if (status) setStatus(status);
  });
  c.on(Events.Error, (e) => consola.warn("[DiscordBridge]", e.message));

  setStatus("connecting");
  try {
    await c.login(config.bot_token);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus(/intent/i.test(message) ? "intents_missing" : "token_invalid");
    consola.warn("[DiscordBridge] login failed:", message);
    if (client === c) client = null;
    await c.destroy();
  }
}

export async function stopDiscordBridge(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.destroy();
}
