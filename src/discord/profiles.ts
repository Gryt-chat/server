import type { GuildMember } from "discord.js";

import { updateDiscordSenderProfile } from "../db";
import type { DiscordRowBuilder } from "../import/discord/rows";
import { resetMessageCache } from "../socket/utils/messageCache";
import type { discordCdnAssets } from "./assets";

/** Their copied messages take the name and picture they have on Discord now. */
export async function refreshDiscordProfiles(members: Iterable<GuildMember>, rows: DiscordRowBuilder, assets: ReturnType<typeof discordCdnAssets>): Promise<number> {
  let changed = 0;
  for (const m of members) {
    if (m.user.bot) continue;
    const avatar = await rows.avatar(m.displayAvatarURL({ extension: "png", size: 128 }), m.id, assets);
    changed += updateDiscordSenderProfile(m.id, m.displayName, avatar);
  }
  if (changed > 0) resetMessageCache();
  return changed;
}
