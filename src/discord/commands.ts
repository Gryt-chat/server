import { randomInt } from "node:crypto";

import consola from "consola";
import { ApplicationCommandOptionType, Events, MessageFlags, type ApplicationCommandDataResolvable, type Client, type Guild } from "discord.js";

import { deleteMessage, discordPersonMessageIds, getDiscordBridge, getMessageById, unlinkDiscordMember } from "../db";
import { deleteMessageEverywhere } from "../moderation/deleteMessage";
import { pluginRefs } from "../plugins/refs";

/** A code is good for this long, once. */
const CODE_TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface PendingCode {
  discordUserId: string;
  discordName: string;
  expires: number;
}

const codes = new Map<string, PendingCode>();

function newCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/** The Discord person a code was handed to, or null. Using it spends it. */
export function redeemLinkCode(code: string): PendingCode | null {
  const key = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pending = codes.get(key);
  codes.delete(key);
  if (!pending || pending.expires < Date.now()) return null;
  return pending;
}

/** For tests: a code as if `/link` had been run. */
export function issueLinkCode(discordUserId: string, discordName: string): string {
  for (const [k, v] of codes) if (v.discordUserId === discordUserId || v.expires < Date.now()) codes.delete(k);
  const code = newCode();
  codes.set(code, { discordUserId, discordName, expires: Date.now() + CODE_TTL_MS });
  return code;
}

const COMMANDS: ApplicationCommandDataResolvable[] = [
  { name: "link", description: "Get a code to show your Discord messages under your Gryt account" },
  {
    name: "forget-me",
    description: "Remove everything you wrote here from the linked Gryt server",
    options: [{ name: "confirm", description: "Yes, delete my messages from Gryt", type: ApplicationCommandOptionType.Boolean, required: true }],
  },
];

export async function registerCommands(guild: Guild): Promise<void> {
  await guild.commands.set(COMMANDS).catch((e) => consola.warn("[DiscordBridge] couldn't register commands", e));
}

/** Deletes a Discord person's copied messages from Gryt, the same way a moderator's delete does. */
export async function forgetDiscordPerson(discordUserId: string): Promise<number> {
  const removed = await removeDiscordPersonMessages(discordUserId);
  unlinkDiscordMember(discordUserId);
  return removed;
}

/** Every copied message from one Discord person, deleted the way a moderator's delete does it. */
export async function removeDiscordPersonMessages(discordUserId: string): Promise<number> {
  const refs = pluginRefs();
  let removed = 0;
  for (const { conversation_id: conversationId, message_id: messageId } of discordPersonMessageIds(discordUserId)) {
    const message = await getMessageById(conversationId, messageId);
    if (!message) continue;
    const ok = refs
      ? await deleteMessageEverywhere({ io: refs.io, clientsInfo: refs.clientsInfo, sfuClient: refs.sfuClient, conversationId, messageId, message, access: { allowed: true, kind: "channel" } })
      : await deleteMessage(conversationId, messageId);
    if (ok) removed += 1;
  }
  return removed;
}

export function attachCommands(c: Client): void {
  c.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand() || i.guildId !== getDiscordBridge()?.guild_id) return;
    void (async () => {
      if (i.commandName === "link") {
        const code = issueLinkCode(i.user.id, i.user.globalName ?? i.user.username);
        await i.reply({
          content: `Your code is **${code}**. In Gryt, open your profile on this server and choose Link Discord, then enter it. It works once, for 10 minutes. Nobody else can see this message.`,
          flags: MessageFlags.Ephemeral,
        });
      } else if (i.commandName === "forget-me") {
        if (!i.options.getBoolean("confirm", true)) {
          await i.reply({ content: "Nothing was deleted.", flags: MessageFlags.Ephemeral });
          return;
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const removed = await forgetDiscordPerson(i.user.id);
        await i.editReply(`Done. ${removed} of your messages were removed from Gryt. New ones you post here will still be copied while the bridge runs.`);
      }
    })().catch((e) => consola.warn(`[DiscordBridge] /${i.commandName} failed`, e));
  });
}
