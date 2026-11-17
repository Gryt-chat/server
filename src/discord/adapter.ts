import { MessageType, type Embed, type Message, type User } from "discord.js";

import type { DceEmbed, DceMessage, DceUser } from "../import/discord/dce";

const TYPE_NAMES = new Map<MessageType, string>([
  [MessageType.Default, "Default"],
  [MessageType.Reply, "Reply"],
  [MessageType.ThreadCreated, "ThreadCreated"],
]);

function user(u: User, nickname?: string | null): DceUser {
  return { id: u.id, name: u.globalName ?? u.username, nickname: nickname ?? null, isBot: u.bot, avatarUrl: u.displayAvatarURL({ extension: "png", size: 128 }) };
}

function hex(color: number | null): string | null {
  return color === null ? null : `#${color.toString(16).padStart(6, "0")}`;
}

function embed(e: Embed): DceEmbed {
  return {
    title: e.title,
    url: e.url,
    timestamp: e.timestamp,
    description: e.description,
    color: hex(e.color),
    author: e.author ? { name: e.author.name, url: e.author.url ?? null, iconUrl: e.author.iconURL ?? null } : null,
    image: e.image ? { url: e.image.url } : null,
    thumbnail: e.thumbnail ? { url: e.thumbnail.url } : null,
    footer: e.footer ? { text: e.footer.text, iconUrl: e.footer.iconURL ?? null } : null,
    fields: e.fields.map((f) => ({ name: f.name, value: f.value, isInline: !!f.inline })),
  };
}

/** The bot's view of a message, in the export's shape, so one row builder serves both.
    Reaction users aren't in a message; history gets counts, live events add people. */
export function toDceMessage(m: Message): DceMessage {
  return {
    id: m.id,
    type: TYPE_NAMES.get(m.type) ?? String(m.type),
    timestamp: m.createdAt.toISOString(),
    timestampEdited: m.editedAt?.toISOString() ?? null,
    isPinned: m.pinned,
    content: m.content,
    author: user(m.author, m.member?.nickname),
    attachments: [...m.attachments.values()].map((a) => ({ id: a.id, url: a.url, fileName: a.name, fileSizeBytes: a.size })),
    embeds: m.embeds.map(embed),
    stickers: [...m.stickers.values()].map((s) => ({ id: s.id, name: s.name, format: s.format === 3 ? "Lottie" : "PngImage", sourceUrl: s.url })),
    reactions: [...m.reactions.cache.values()].map((r) => ({
      emoji: { id: r.emoji.id, name: r.emoji.name ?? undefined, imageUrl: r.emoji.id ? r.emoji.imageURL({ extension: "png" }) : null },
      count: r.count,
      users: [],
    })),
    mentions: [...m.mentions.users.values()].map((u) => user(u, m.mentions.members?.get(u.id)?.nickname)),
    reference: m.reference ? { messageId: m.reference.messageId ?? null, channelId: m.reference.channelId, guildId: m.reference.guildId ?? null } : null,
  };
}
