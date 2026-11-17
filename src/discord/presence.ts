import consola from "consola";
import { Events, type Client, type Guild } from "discord.js";

import { getDiscordBridge, isExcludedFromBridge, listDiscordMemberLinks } from "../db";
import { pluginRefs } from "../plugins/refs";

export type DiscordStatus = "online" | "idle" | "dnd" | "offline";

export interface DiscordPresence {
  discordUserId: string;
  name: string;
  avatar: string;
  status: DiscordStatus;
}

let fetchedFor: string | null = null;

/** Discord allows one full member list per 30 seconds; the members intent keeps the cache current after it. */
export async function ensureMembers(guild: Guild): Promise<void> {
  if (fetchedFor === guild.id) return;
  try {
    await guild.members.fetch({ withPresences: true });
    fetchedFor = guild.id;
  } catch (e) {
    consola.warn("[DiscordBridge] couldn't list Discord members", e);
  }
}

/** People on the linked Discord server who are synced and not linked to a member here; a linked one shows as that member. */
export function discordPresence(guild: Guild): DiscordPresence[] {
  const linked = new Set(listDiscordMemberLinks().map((l) => l.discord_user_id));
  const out: DiscordPresence[] = [];
  for (const m of guild.members.cache.values()) {
    if (m.user.bot || linked.has(m.id) || isExcludedFromBridge("discord", m.id)) continue;
    const s = m.presence?.status;
    out.push({
      discordUserId: m.id,
      name: m.displayName,
      avatar: m.displayAvatarURL({ extension: "png", size: 64 }),
      status: s === "online" || s === "idle" || s === "dnd" ? s : "offline",
    });
  }
  return out;
}

let pending: NodeJS.Timeout | null = null;

/** A nudge, not the list: clients ask for it again, so one burst of status changes costs one fetch each. */
function nudge(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    pluginRefs()?.io.emit("discord:people");
  }, 3000);
}

export function attachPresence(c: Client): void {
  const ours = (guildId: string | undefined | null) => !!guildId && guildId === getDiscordBridge()?.guild_id;
  c.on(Events.PresenceUpdate, (_before, after) => {
    if (ours(after.guild?.id)) nudge();
  });
  c.on(Events.GuildMemberAdd, (m) => ours(m.guild.id) && nudge());
  c.on(Events.GuildMemberRemove, (m) => ours(m.guild.id) && nudge());
  c.on(Events.GuildMemberUpdate, (_b, m) => ours(m.guild.id) && nudge());
}
