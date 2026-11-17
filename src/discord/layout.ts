import consola from "consola";
import { ChannelType, Events, type Client, type DMChannel, type GuildChannel, type NonThreadGuildBasedChannel } from "discord.js";

import { getDiscordBridge, grytChannelFor, renameServerChannel, saveDiscordBridgeChannel, setDiscordChannelMatch } from "../db";
import { clip } from "../import/discord/content";
import { importedId } from "../import/discord/ids";
import { createImportedChannels, type ChannelPlan } from "../import/discord/importer";
import { broadcastServerUiUpdate } from "../socket/utils/server";

const TEXT = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const VOICE = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

function syncing(guildId: string): boolean {
  const b = getDiscordBridge();
  return !!b && b.guild_id === guildId && b.direction !== "to_discord" && b.copy_status !== "idle";
}

function kindOf(c: GuildChannel): ChannelPlan["kind"] | null {
  if (TEXT.has(c.type)) return "text";
  if (VOICE.has(c.type)) return "voice";
  return c.type === ChannelType.GuildForum ? "forum" : null;
}

function planOf(c: GuildChannel, kind: ChannelPlan["kind"]): ChannelPlan {
  return {
    id: c.id,
    name: clip(c.name, 80) ?? `channel-${c.id}`,
    kind,
    topic: "topic" in c ? (clip(c.topic as string | null, 200) ?? null) : null,
    categoryId: c.parentId,
    categoryName: c.parent ? (clip(c.parent.name, 80) ?? null) : null,
  };
}

/** Discord's layout into Gryt as it changes: new channels, renames and topics. A deleted Discord
    channel stops syncing and keeps its Gryt channel; removing that is the owner's call in the tab. */
export function attachLayoutSync(c: Client): void {
  const run = (name: string, fn: () => Promise<void>) => void fn().catch((e) => consola.warn(`[DiscordBridge] ${name} failed`, e));

  c.on(Events.ChannelCreate, (ch: NonThreadGuildBasedChannel) =>
    run("new channel", async () => {
      const kind = kindOf(ch);
      if (!kind || !syncing(ch.guildId)) return;
      const target = grytChannelFor(ch.id, importedId("channel", ch.id));
      if (!target) return;
      await createImportedChannels([{ ...planOf(ch, kind), grytChannelId: target }]);
      saveDiscordBridgeChannel({ discord_channel_id: ch.id, gryt_channel_id: target, backfill_before: null, backfill_done: true });
      broadcastServerUiUpdate("other");
    }),
  );

  c.on(Events.ChannelUpdate, (before: DMChannel | NonThreadGuildBasedChannel, after: DMChannel | NonThreadGuildBasedChannel) =>
    run("channel change", async () => {
      if (after.isDMBased() || before.isDMBased() || !syncing(after.guildId)) return;
      const topic = (x: GuildChannel) => ("topic" in x ? ((x.topic as string | null) ?? null) : null);
      if (before.name === after.name && topic(before) === topic(after)) return;
      const target = grytChannelFor(after.id, importedId("channel", after.id));
      if (target && (await renameServerChannel(target, after.name, topic(after)))) broadcastServerUiUpdate("other");
    }),
  );

  c.on(Events.ChannelDelete, (ch: DMChannel | NonThreadGuildBasedChannel) =>
    run("channel removal", async () => {
      if (ch.isDMBased() || !syncing(ch.guildId)) return;
      setDiscordChannelMatch(ch.id, "skip");
    }),
  );
}
