/**
 * The parts of a DiscordChatExporter JSON export the importer reads. Field names
 * are DCE's (JsonMessageWriter.cs). Everything is optional: the file is untrusted.
 */

export interface DceGuild {
  id?: string;
  name?: string;
  iconUrl?: string;
}

export interface DceChannel {
  id?: string;
  /** ChannelKind's name, e.g. GuildTextChat, GuildPublicThread. */
  type?: string;
  /** The category for a channel, but the parent channel for a thread. */
  categoryId?: string | null;
  category?: string | null;
  name?: string;
  topic?: string | null;
}

export interface DceRole {
  id?: string;
  name?: string;
  color?: string | null;
  position?: number;
}

export interface DceUser {
  id?: string;
  name?: string;
  discriminator?: string;
  nickname?: string | null;
  color?: string | null;
  isBot?: boolean;
  roles?: DceRole[];
  avatarUrl?: string | null;
}

export interface DceEmoji {
  /** Empty for a Unicode emoji. */
  id?: string | null;
  name?: string;
  code?: string;
  isAnimated?: boolean;
  imageUrl?: string | null;
}

export interface DceAttachment {
  id?: string;
  url?: string;
  fileName?: string;
  fileSizeBytes?: number;
}

export interface DceEmbedImage {
  url?: string | null;
  canonicalUrl?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface DceEmbed {
  title?: string | null;
  url?: string | null;
  timestamp?: string | null;
  description?: string | null;
  color?: string | null;
  author?: { name?: string | null; url?: string | null; iconUrl?: string | null } | null;
  thumbnail?: DceEmbedImage | null;
  image?: DceEmbedImage | null;
  images?: DceEmbedImage[];
  video?: DceEmbedImage | null;
  footer?: { text?: string | null; iconUrl?: string | null } | null;
  fields?: { name?: string; value?: string; isInline?: boolean }[];
}

export interface DceSticker {
  id?: string;
  name?: string;
  /** PngImage, Apng, Lottie or GifImage. */
  format?: string;
  sourceUrl?: string;
}

export interface DceReaction {
  emoji?: DceEmoji;
  count?: number;
  users?: DceUser[];
}

export interface DceReference {
  type?: string;
  messageId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
}

export interface DceMessage {
  id?: string;
  type?: string;
  timestamp?: string;
  timestampEdited?: string | null;
  isPinned?: boolean;
  content?: string;
  author?: DceUser;
  attachments?: DceAttachment[];
  embeds?: DceEmbed[];
  stickers?: DceSticker[];
  reactions?: DceReaction[];
  mentions?: DceUser[];
  reference?: DceReference | null;
  forwardedMessage?: { content?: string; attachments?: DceAttachment[] } | null;
  inlineEmojis?: DceEmoji[];
}

export interface DceExport {
  guild?: DceGuild;
  channel?: DceChannel;
  exportedAt?: string;
  messages?: DceMessage[];
  messageCount?: number;
}

export const THREAD_TYPES = new Set(["GuildNewsThread", "GuildPublicThread", "GuildPrivateThread"]);
export const VOICE_TYPES = new Set(["GuildVoiceChat", "GuildStageVoice"]);
export const DM_TYPES = new Set(["DirectTextChat", "DirectGroupTextChat"]);

/** What becomes a Gryt message. The rest are notices Gryt has no equivalent for. */
export const IMPORTED_MESSAGE_TYPES = new Set(["Default", "Reply", "ThreadCreated"]);

/** Discord ids are snowflakes. Anything else in an id field is refused. */
export function isSnowflake(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]{1,20}$/.test(v);
}
