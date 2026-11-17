import consola from "consola";
import type { Guild } from "discord.js";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

import { getServerConfig, updateServerConfig } from "../db";
import { deleteObject, putObject, uploadsFolder } from "../storage";
import { MAX_INPUT_PIXELS } from "../utils/imageValidation";
import type { discordCdnAssets } from "./assets";

/** The owner chose to take the Discord server's name and icon. The icon is sized like an uploaded one. */
export async function takeDiscordIdentity(guild: Guild, assets: ReturnType<typeof discordCdnAssets>): Promise<void> {
  const previous = (await getServerConfig().catch(() => null))?.icon_url ?? null;
  const iconUrl = guild.iconURL({ extension: "png", size: 256 });
  let key: string | null = null;
  const found = iconUrl ? await assets.resolve(iconUrl) : null;
  if (found) {
    try {
      const body = await sharp(found.path, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).resize(256, 256, { fit: "cover" }).avif().toBuffer();
      key = `server-icons/discord-bridge/${uuidv4()}.avif`;
      await putObject({ bucket: uploadsFolder(), key, body, contentType: "image/avif" });
    } catch (e) {
      consola.warn("[DiscordBridge] couldn't store the Discord icon", e);
      key = null;
    }
  }
  await updateServerConfig({ displayName: guild.name.slice(0, 100), ...(key ? { iconUrl: key } : {}), isConfigured: true });
  if (key && previous && previous !== key) await deleteObject({ bucket: uploadsFolder(), key: previous }).catch(() => undefined);
}
